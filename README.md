# Eyevinn Schedule Service Adapter

A Channel Engine adapter to get channels and schedules from an Eyevinn Schedule Service.

## Installation

```
npm install --save @eyevinn/schedule-service-adapter
```

## Usage

Initiate the Eyevinn Channel Engine with the adapter for the Eyevinn Schedule Service:

```
const DemoChannelEngine = require("eyevinn-channel-engine");
const { ChannelManager, AssetManager } = require("@eyevinn/schedule-service-adapter");

const channelManager = new ChannelManager({
  scheduleServiceEndpoint: new URL("https://schedule.vc.eyevinn.technology/api/v1")
});
const assetManager = new AssetManager({
  channelManager: channelManager,
});

const run = async () => {
  await channelManager.init();

  const engine = new DemoChannelEngine(assetManager, {
    channelManager: channelManager,
  });
  engine.start();
  engine.listen(8000);
};
run();
```

# About Eyevinn Technology

Eyevinn Technology is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor.

At Eyevinn, every software developer consultant has a dedicated budget reserved for open source development and contribution to the open source community. This give us room for innovation, team building and personal competence development. And also gives us as a company a way to contribute back to the open source community.

Want to know more about Eyevinn and how it is to work here. Contact us at work@eyevinn.se!