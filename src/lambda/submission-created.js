const Currency = require("../components/Currency");

const joinFormRecipients = process.env.JOIN_FORM_RECIPIENTS;
const contactFormRecipients = process.env.CONTACT_FORM_RECIPIENTS;
const checkoutRecipients = process.env.CHECKOUT_RECIPIENTS;
const mailgun = require("mailgun-js")({
  apiKey: process.env.MAILGUN_API_KEY,
  domain: process.env.MAILGUN_DOMAIN,
});
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mailchimpApiKey = process.env.MAILCHIMP_API_KEY;
const mailchimpSubscribeURL = process.env.MAILCHIMP_SUBSCRIBE_URL;
const fetch = require('node-fetch');
const crypto = require('crypto');
const lineCharLength = 72;

exports.handler = async (event, context, callback) => {
  const body = JSON.parse(event.body).payload;

  // Join form
  if (body['form-name'] === 'join') {
    await processJoinOrRenewalForm('join', body);
    return {
      statusCode: 200
    };
  }

  // Renewal form
  if (body['form-name'] === 'renew') {
    await processJoinOrRenewalForm('renew', body);
    return {
      statusCode: 200
    };
  }

  // Contact form
  if (body['form-name'] === 'contact') {
    await processContactForm(body);
    return {
      statusCode: 200
    };
  }

  // Cart checkout
  if (body['form-name'] === 'checkout') {
    await processCheckout(body);
    return {
      statusCode: 200
    };
  }

  throw new Error(`Unhandled form submission for ${body['form-name']}`)
};

async function processJoinOrRenewalForm(action, body) {
  // Get data for Stripe SKU
  const membership = await getStripeSku(body.membership);

  // Create email body
  const message = `Hello!
  
${action === `join` ? `A new member has joined the club!` : `We've had a membership renewal!`}

PERSONAL DETAILS
================

First name:       ${body.firstName}
Last name:        ${body.lastName}
Date of birth:    ${body.dateOfBirth}
Gender:           ${body.gender}

CONTACT INFO
============
Address:          ${body.addressLine1}
                  ${body.addressLine2}
                  ${body.addressLine3}
                  ${body.addressLine4}
                  ${body.locality}
                  ${body.town}
                  ${body.county}
                  ${body.postcode}
                
Telephone:        ${body.telephone !== "" ? body.telephone : "Not provided"}
Email:            ${body.email.toLowerCase()}

SUBSCRIPTIONS
=============
Newsletter:       ${body.newsletter}
WhatsApp:         ${body.telephone !== "" ? body.whatsApp : "No"}

EMERGENCY CONTACT
=================
Name:             ${body.emergencyContactName !== "" ? body.emergencyContactName : "Not provided"}
Telephone:        ${body.emergencyContactNumber !== "" ? body.emergencyContactNumber : "Not provided"}

MEMBERSHIP INFO
===============
Claim:            ${membership.attributes.claim}
First claim club: ${membership.attributes.claim === "First" ? "Manchester YMCA Harriers" : body.firstClaimClub}
Valid until:      ${membership.attributes.valid_to}

Y CLUB MEMBERSHIP
=================
Y Club member:    ${body.yClubMembership}

DECLARATIONS
============
Accepted:         Yes

PAYMENT
=======
Amount due:       ${Currency(membership.price)}
Payment method:   ${body.paymentMethod}

Thanks!

The Manchester YMCA Harriers website
`;

  // Send to recipients
  await sendMessageWithMailgun(joinFormRecipients, `Manchester YMCA Harriers Website <webmaster@manyharrier.co.uk>`, `${action === "join" ? "New" : "Renewal for"} ${membership.attributes.claim.toLowerCase()}-claim member: ${body.firstName} ${body.lastName}`, message);

  // Sign-up for Newsletter (if opted in)
  if (body.newsletter.toLowerCase() === "yes") {
    await subscribeToMailingList(body.email, body.firstName, body.lastName)
  } else {
    await unsubscribeFromMailingList(body.email)
  }
}

async function processContactForm(body) {
  await sendMessageWithMailgun(contactFormRecipients, `${body.name} <${body.email}>`, body.reason, body.message);
}

async function processCheckout(body) {
  // Get data for Stripe SKUs
  let total = 0;

  const items = [];

  for (let item of body.items) {
    const stripeSku = await getStripeSku(item.sku);
    const item = JSON.parse(item);
    item.price = stripeSku.price;
    total += item.price * item.quantity;
    const line = `${item.quantity} x ${item.description} @ ${Currency(item.price)}`;
    const subtotal = `${Currency(item.quantity * item.price)}`;
    const spaces = lineCharLength - (line.length + subtotal.length);
    items.push({
      sortKey: item.description,
      line: `${line}${' '.repeat(Math.max(spaces, 1))}${subtotal}`
    })
  }

  items.sort((a, b) => {
    return a.sortKey < b.sortKey ? -1 : 1
  });

  total = `Total: ${Currency(total)}`;
  const totalLine = ' '.repeat(lineCharLength - total.length);

  // Create email body
  let message = `Hello!
  
An order has been placed through the website:

CUSTOMER DETAILS
================

First name:       ${body.firstName}
Last name:        ${body.lastName}
Email:            ${body.email}

ORDER
=====`;

  items.forEach(({line}) => {
    message += line + "\n"
  });

  message += `${'-'.repeat(lineCharLength)}` + "\n";
  message += `${totalLine}` + "\n";
  message += `${'-'.repeat(lineCharLength)}` + "\n";

  message += `

Payment method: ${body.paymentMethod}

Thanks!

The Manchester YMCA Harriers website
`;

  await sendMessageWithMailgun(checkoutRecipients, `Manchester YMCA Harriers Website <webmaster@manyharrier.co.uk>`, `Order received from ${body.firstName} ${body.lastName}`, message);
}

async function sendMessageWithMailgun(to, from, subject, body) {
  let data = {
    to: (to instanceof Array) ? to.join(',') : to,
    from: from,
    subject: subject,
    text: body,
  };

  return mailgun.messages().send(data)
}

async function getStripeSku(sku) {
  return new Promise((resolve, reject) => {
    stripe.skus.retrieve(sku, (err, sku) => {
      if (err) {
        reject(err);
        return
      }
      resolve(sku)
    })
  })
}

async function subscribeToMailingList(email, firstName, lastName) {
  const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

  const isAlreadySubscribed = await fetch(mailchimpSubscribeURL + emailHash, {
    headers: {
      "Authorization": `Basic ${Buffer.from("user:" + mailchimpApiKey).toString('base64')}`,
    }
  });

  if (isAlreadySubscribed.ok) {
    return
  }

  if (isAlreadySubscribed.status !== 404) {
    throw new Error(`response from Mailchimp API was ${isAlreadySubscribed.status}`)
  }

  const data = {
    email_address: email.toLowerCase(),
    status: "pending",
    merge_fields: {
      FNAME: firstName,
      LNAME: lastName
    }
  };

  const createSubscription = await fetch(mailchimpSubscribeURL, {
    method: "POST",
    body: JSON.stringify(data),
    headers: {
      "Authorization": `Basic ${Buffer.from("user:" + mailchimpApiKey).toString('base64')}`,
      "Content-Type": "application/json"
    }
  });

  if (!createSubscription.ok) {
    throw new Error(`response from Mailchimp API was ${createSubscription.status}`)
  }
}

async function unsubscribeFromMailingList(email) {
  const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

  const isSubscribed = await fetch(mailchimpSubscribeURL + emailHash, {
    headers: {
      "Authorization": `Basic ${Buffer.from("user:" + mailchimpApiKey).toString('base64')}`,
    }
  });

  if (!isSubscribed.ok) {
    if (isSubscribed.status !== 404) {
      return
    }
    throw new Error(`response from Mailchimp API was ${isSubscribed.status}`)
  }

  const data = {
    status: "unsubscribed",
  };

  const unsubscribe = await fetch(mailchimpSubscribeURL + emailHash, {
    method: "PATCH",
    body: JSON.stringify(data),
    headers: {
      "Authorization": `Basic ${Buffer.from("user:" + mailchimpApiKey).toString('base64')}`,
      "Content-Type": "application/json"
    }
  });

  if (!unsubscribe.ok) {
    throw new Error(`cannot unsubscribe ${email}: response from Mailchimp API was ${unsubscribe.status}`)
  }
}