---
title: AI models and provider keys
summary: Choosing the default model and provider, adding or removing API keys, a Wisp's own model and reasoning level, the output token limit, and the image model for Wisps whose model cannot see images.
---
# AI models and provider keys

## Default model and keys

[AI Model](wisp://settings/model) holds the provider and model every Wisp
uses unless it has its own, the **Maximum output tokens**, the **Reasoning**
level (how much the model thinks before it answers; higher levels cost more
and reply slower), and the API key of each provider. Only API keys are supported; they are stored encrypted and are
shared by every Wisp using that provider. Removing a key stops the Wisps that
use that provider until a key is saved again.

The model list comes from the runtime's catalog, refreshed in the background;
a failed refresh is shown in this panel.

## A Wisp's own model

A Wisp's model is chosen when it is created (see *Getting started*).
Its [Model](wisp://wisp/model) page shows the model it runs on and lets you
pick its reasoning level when the model supports one. The conversation header
shows the model in use. If its model or key becomes unusable, the Wisp asks
for configuration rather than switching to another provider.

## Images and models that cannot see them

Some models cannot read images. **Auxiliary models → Image understanding** in
[AI Model](wisp://settings/model) picks a second model that reads images and
scanned PDF pages for those Wisps and gives them a text description. It is
**Off** by default and lists only image-capable models whose provider has a
saved key. The composer says when a Wisp's model cannot see images.

## When sending is disabled

If the composer says to choose a provider and model, select **Configure AI
model** or open [AI Model](wisp://settings/model). Your draft is kept.
