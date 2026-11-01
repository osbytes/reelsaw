"use strict";

const { callTool, isNotFound } = require("./mcp");
const { itemFromBody, sampleItem } = require("./payloads");

/**
 * A REST Hook trigger for one Reelsaw webhook event. Turning the Zap on calls create_webhook with Zapier's hook URL
 * and that one event; turning it off calls delete_webhook. Reelsaw signs, retries (8 times over about 22 h) and logs
 * every delivery, and turns an endpoint off when Zapier answers 410 Gone.
 *
 * Signatures (Standard Webhooks) are not verified here: the hook URL Zapier generates is itself a secret, and the
 * signing secret create_webhook returns is not kept (it would only sit in subscribeData unused).
 */
function hookTrigger({ key, noun, label, description, event, performList, outputFields }) {
  const performSubscribe = async (z, bundle) => {
    const r = await callTool(z, bundle, "create_webhook", {
      url: bundle.targetUrl,
      events: [event],
      description: `Zapier: ${label}`.slice(0, 120),
    });
    // Zapier stores this as bundle.subscribeData for performUnsubscribe; the secret is deliberately left out
    return { id: r.endpoint.id, events: r.endpoint.events };
  };

  const performUnsubscribe = async (z, bundle) => {
    const id = bundle.subscribeData && bundle.subscribeData.id;
    if (!id) return { ok: true, message: "Nothing to unsubscribe." };
    try {
      return await callTool(z, bundle, "delete_webhook", { id });
    } catch (err) {
      // already deleted in Settings → Webhooks, or turned off after Zapier answered 410: the goal is reached
      if (isNotFound(err)) return { ok: true, message: "The webhook was already gone." };
      throw err;
    }
  };

  const perform = (z, bundle) => {
    const body = bundle.cleanedRequest;
    // a webhook.test delivery (Send test in Reelsaw) or anything else this hook was not subscribed to starts nothing
    if (!body || typeof body !== "object" || body.type !== event) return [];
    return [itemFromBody(body)];
  };

  return {
    key,
    noun,
    display: { label, description },
    operation: {
      type: "hook",
      inputFields: [],
      performSubscribe,
      performUnsubscribe,
      perform,
      performList,
      sample: sampleItem(event),
      outputFields,
    },
  };
}

module.exports = { hookTrigger };
