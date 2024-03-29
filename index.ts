import fetch from "node-fetch";
import Debug from "debug";
import dayjs from "dayjs";

const debug = Debug("schedule-service-adapter");

export interface IChannelManagerOptions {
  scheduleServiceEndpoint: URL;
}

export interface IAssetManagerOptions {
  channelManager: ChannelManager;
}

interface IChannelAttrs {
  id: string;
  title?: string;
  scheduleEndpoint: URL;
  audioTracks?: IAudioTracks[];
}

interface IAudioTracks {
  language: string;
  name: string;
  default: boolean;
}

interface IChannelResponse {
  id: string;
  tenant: string;
  title: string;
  audioTracks?: IAudioTracks[];
}

enum ScheduleEventType {
  VOD = "VOD",
  LIVE = "LIVE"
}

interface IScheduleEventResponse {
  id: string;
  channelId: string;
  title: string;
  start_time: number;
  end_time: number;
  start: string;
  end: string;
  url: string;
  duration: number;
  type: ScheduleEventType;
  liveUrl?: string;
}

interface ILiveScheduleEvent{
  id: string;
  channelId: string;
  start_time: number;
  end_time: number;
  start: string;
  end: string;
  duration: number;
  url: string;
}

interface IVod extends IScheduleEventResponse {
  offset?: number;
  gap?: number;
}

interface ILive {
  eventId: string;
  assetId: string;
  title: string;
  type: number;
  start_time: number;
  start: string;
  end_time: number;
  end: string;
  uri: string;
  duration: number;
}

interface INextVodRequest {
  playlistId: string;
}

interface INextVodResponse {
  id: string;
  title: string;
  uri: string;
  offset?: number;
  diffMs?: number;
  desiredDuration?: number;
  type?: string;
}

const retry = (fn: any, ms: number, maxRetries: number) => new Promise((resolve, reject) => {
  fn()
    .then(resolve)
    .catch((err: string) => {
      if (maxRetries > 0) {
        setTimeout(() => {
          retry(fn, ms, maxRetries - 1).then(resolve).catch(reject);
        }, ms)
      } else {
        reject(err);
      }
    });
});

export class Channel {
  private attrs: IChannelAttrs;
  private channelManager: ChannelManager;

  constructor(attrs: IChannelAttrs, channelManager: ChannelManager) {
    this.attrs = attrs;
    this.channelManager = channelManager;
  }

  get id() {
    return this.attrs.id;
  }

  get title() {
    return this.attrs.title;
  }

  get audioTracks() {
    return this.attrs.audioTracks;
  }

  get scheduleEndpoint() {
    return this.attrs.scheduleEndpoint;
  }
  
  get profile() {
    return [
      { bw: 409000, codecs: 'mp4a.40.2,avc1.42C01E', resolution: [384, 216] },
      { bw: 881000, codecs: 'mp4a.40.2,avc1.42C01E', resolution: [640, 360] },
      { bw: 2588000, codecs: 'mp4a.40.2,avc1.42C01E', resolution: [1024, 576] },
      { bw: 3606000, codecs: 'mp4a.40.2,avc1.42C01E', resolution: [1280, 720] },
    ];
  }

  async getLiveSchedule(): Promise<ILive[]> {
    try {
      const WINDOW_SIZE = 3600; // seconds
      const currentTs = dayjs().valueOf();
      let scheduleQuery = this.scheduleEndpoint.href
        + "?start=" + dayjs(currentTs - WINDOW_SIZE * 1000).toISOString() 
        + "&end=" + dayjs(currentTs + WINDOW_SIZE * 1000).toISOString();
      debug(`[${this.id}]: Fetch schedules ${scheduleQuery}`);
      const response = await fetch(scheduleQuery);
      if (response.ok) {
        const data = await response.json();
        const schedule: ILive[] = data.filter((ev: IScheduleEventResponse) => ev.type === ScheduleEventType.LIVE).map((ev: IScheduleEventResponse): ILive => {
          return {
            eventId: ev.id,
            assetId: ev.channelId,
            title: "LIVE EVENT",
            start_time: ev.start_time,
            start: ev.start,
            end_time: ev.end_time,
            end: ev.end,
            uri: ev.liveUrl,
            duration: ev.duration,
            type: 1,
          };
        });
        return schedule;
      } else {
        throw new Error(`Schedule service responded with (${response.status}):"${response.statusText}"`);
      }
    } catch (err) {
      console.error("Failed to get LIVE schedule: ", err.message);
      throw err;    
    }
  }

  async getSchedule(timestamp?: number): Promise<IVod> {
    try {
      const WINDOW_SIZE = 300; // seconds
      const currentTs = timestamp ? timestamp : dayjs().valueOf();
      let scheduleQuery = this.scheduleEndpoint.href 
        + "?start=" + dayjs(currentTs - WINDOW_SIZE * 1000).toISOString() 
        + "&end=" + dayjs(currentTs + WINDOW_SIZE * 1000).toISOString();
      debug(`[${this.id}]: Fetch schedules ${scheduleQuery}`);

      const response = await fetch(scheduleQuery);
      if (!response.ok) {
        throw new Error(`Schedule service responded with (${response.status}):"${response.statusText}"`);
      }
      const data = await response.json();
      debug(data);
      if (data.length > 0) {
        let currentVod: IVod|null = data[0];
        debug(`Finding VOD for timestamp ${currentTs} (${dayjs(currentTs).toISOString()}) (${data.length})`);
        const lastEvents = this.channelManager.getAsRun(this.id, 3);
        let i = 0;
        let lastSkipped = null;
        debug(lastEvents);
        if (lastEvents) {
          if (data.length > 1) {
            while(data[i+1] && lastEvents.find(event => event.id === currentVod?.id) || (currentTs >= data[i].end_time)) {
              debug("Skipping:");
              debug(data[i]);
              lastSkipped = data[i];
              currentVod = data[++i];
            }
            if (i > 0 && currentVod !== null) {
              currentVod.offset = 0;
            }
            if (lastEvents.find(event => event.id === currentVod?.id)) {
              debug("last event in the schedule has already been played");
              currentVod = null;
            }
          } else {
            if (lastEvents.find(event => event.id === currentVod?.id)) {
              debug("no event to select");
              currentVod = null;
            } else {
              lastSkipped = lastEvents[lastEvents.length - 1];
            }
          }
        }
        if (currentVod) {
          debug("chosen event");
          debug(currentVod);
          if (currentTs < (currentVod.start_time - 4000)) {
            if (!lastSkipped || lastSkipped.end_time != currentVod.start_time) {
              const gap = currentVod.start_time - currentTs;
              debug(`First event not started yet, will start in ${gap} milliseconds`);
              return <IVod>{ gap: gap };
            } else {
              debug(`Last event is back to back, no need for a gap`);
              return currentVod;
            }
          } else if (currentTs > currentVod.end_time) {
            debug("Chosen event's end_time has passed");
            throw new Error("Chosen event's end_time has passed");
          } else {
            return currentVod;
          }
        } else {
          throw new Error("No event found");
        }
      } else {
        throw new Error("Empty schedule");
      }
    } catch (err) {
      console.error("Failed to get next VOD: ", err.message);
      throw err;    
    }
  }
}

const CHANNEL_REFRESH_INTERVAL: number = 10 * 1000;

export class ChannelManager {
  private timer: NodeJS.Timer;
  private endpoint: URL;
  private isConnected: boolean;
  private channelList: Record<string, Channel>;
  private asrunLog: Record<string, IVod[]>;
  private useDemuxedAudio: boolean;

  constructor(options: IChannelManagerOptions) {
    this.endpoint = options.scheduleServiceEndpoint;
    this.isConnected = false;
    this.channelList = {};
    this.asrunLog = {};
    this.useDemuxedAudio = false;

    this.timer = setInterval(async () => {
      try {
        await this.refreshChannelList();
      } catch (err) {
        console.error("Failed to connect to schedule service");
        console.error(err);
      }
    }, CHANNEL_REFRESH_INTERVAL / 10);
  }

  async init() {
    await this.refreshChannelList();
  }

  async refreshChannelList() {
    const requestUrl = new URL(this.endpoint.href + "/channels");
    debug(`Refresh channel list from: ${requestUrl.href} (useDemuxedAudio=${this.useDemuxedAudio})`);
    const response = await fetch(requestUrl.href);
    const channels: IChannelResponse[] = await response.json();
    channels.map(ch => {
      const channel = new Channel({
        id: ch.id,
        audioTracks: ch.audioTracks,
        scheduleEndpoint: new URL(this.endpoint.href + "/channels/" + ch.id + "/schedule"),
      }, this);
      if (this.useDemuxedAudio) {
        if (channel.audioTracks && channel.audioTracks.length > 0) {
          // When demuxed audio is enabled the channel needs to have 
          // an audio track configuration
          this.addChannel(channel);
        }
      } else {
        if (!channel.audioTracks) {
          this.addChannel(channel);
        }
      }
    });
    Object.keys(this.channelList).map(channelId => {
      if (!channels.find(ch => ch.id === channelId)) {
        this.removeChannel(channelId);
      }
    });
    if (!this.isConnected) {
      this.isConnected = true;
      clearInterval(this.timer);
      this.timer = setInterval(async () => await this.refreshChannelList(), CHANNEL_REFRESH_INTERVAL);
    }
  }

  addChannel(channel: Channel) {
    if (!this.channelList[channel.id]) {
      debug(`Adding channel ${channel.id}:${channel.title} to channel list`);
    } else {
      debug(`Updating channel ${channel.id}:${channel.title} in channel list`);
    }
    this.channelList[channel.id] = channel;
  }

  removeChannel(channelId: string) {
    debug(`Removing channel ${channelId} from channel list`);
    delete this.channelList[channelId];
  }

  getChannel(channelId: string): Channel {
    return this.channelList[channelId];
  }

  getChannels(): Channel[] {
    return Object.keys(this.channelList).map(id => this.channelList[id]);
  }

  log(channelId: string, scheduleEvent: any) {
    if (!this.asrunLog[channelId]) {
      this.asrunLog[channelId] = [];
    }
    this.asrunLog[channelId].push(scheduleEvent);
  }

  removeLog(channelId: string, id: string) {
    if (this.asrunLog[channelId]) {
      const idx = this.asrunLog[channelId].findIndex(event => event.id === id);
      this.asrunLog[channelId].splice(idx, 1);
    }
  }

  getAsRun(channelId: string, num: number): IVod[] {
    if (!this.asrunLog[channelId]) {
      this.asrunLog[channelId] = [];
    }
    return this.asrunLog[channelId].slice(-num);
  }

  setUseDemuxedAudio(useDemuxedAudio: boolean) {
    this.useDemuxedAudio = useDemuxedAudio;
  }
}

export class AssetManager {
  private channelManager: ChannelManager;

  constructor(options: IAssetManagerOptions) {
    this.channelManager = options.channelManager;
  }

  getNextVod(vodRequest: INextVodRequest): Promise<INextVodResponse> {
    const channel: Channel = this.channelManager.getChannel(vodRequest.playlistId);
    debug("getNextVod()");
    return new Promise<INextVodResponse>((resolve, reject) => {
      const delayMs = 2000;
      retry(() => new Promise((success, fail) => {
        channel.getSchedule()
        .then(currentVod => {
          if (currentVod.gap) {
            debug(`Requesting to insert placeholder VOD to fill a gap ${currentVod.gap} of milliseconds`);
            success({ id: 'GAP', title: 'GAP', desiredDuration: currentVod.gap, type: 'gap' });
          } else {
            const now = dayjs();
            debug(`Current timestamp: ${now.toISOString()}`);
            let offset;
            if (currentVod.offset !== 0) {
              offset = Math.floor((now.valueOf() - currentVod.start_time) / 1000);
            }

            this.channelManager.log(vodRequest.playlistId, currentVod);
            const scheduleDiffMs = currentVod.start_time - now.valueOf();
            const timedMetadata = {
              "id": currentVod.id,
              "start-date": dayjs(currentVod.start_time).toISOString(),
              "x-schedule-end": dayjs(currentVod.end_time).toISOString(),
              "x-title": currentVod.title.replace(/"/g, "'"),
              "x-channelid": vodRequest.playlistId,
              "class": "se.eyevinn.schedule",
            };
            debug({ id: currentVod.id, title: currentVod.title, uri: currentVod.url, offset: (offset && offset > 0) ? offset : 0, diffMs: scheduleDiffMs, timedMetadata: timedMetadata });
            success({ id: currentVod.id,
              title: currentVod.title,
              uri: currentVod.url,
              offset: (offset && offset > 0) ? offset : 0,
              diffMs: scheduleDiffMs,
              timedMetadata: timedMetadata,
            });
          }
        }).catch(err => {
          debug(`Get schedule failed. Trying Again in (${delayMs})ms.\nvodRequest=${JSON.stringify(vodRequest, null, 2)}`);
          fail(err);
        })
      }), delayMs, 3)
      .then((vodResponse: any) => {
        resolve(vodResponse);
      })
      .catch(err => {
        debug(err);
        console.error("Max retries reached");
        reject("Failed to get next VOD from scheduler");
      });
    })
  }

  handleError(err, vodResponse) {
    console.error(err.message);
    if (vodResponse && vodResponse.id) {
      debug(vodResponse);
      debug(`Removing ${vodResponse.id} from asrun ${vodResponse.playlistId} as it failed to load`);
      this.channelManager.removeLog(vodResponse.playlistId, vodResponse.id);
    }
  }
}

export class StreamSwitchManager {
  private channelManager: ChannelManager;

  constructor({ channelManager }) {
    this.channelManager = channelManager;
  }

  async getSchedule(channelId) {
    const channel = this.channelManager.getChannel(channelId);
    const delayMs = 2000;
    try {
      const liveSchedule = await retry(() => new Promise((success, fail) => {
        channel.getLiveSchedule()
        .then((schedule: ILive[]) => {
          if (schedule.length > 0) {
            debug(`[${channelId}]: Next live event:`);
            const nextLiveEvent = schedule.find(ev => ev.start_time >= dayjs().valueOf());
            debug(nextLiveEvent);
          }
          success(schedule);
        })
        .catch(exc => {
          console.error(`Get schedule failed. Trying Again in (${delayMs})ms.`);
          fail(exc);
        });
      }), delayMs, 3);
      return liveSchedule;
    } catch(err) {
      debug(err);
      console.error("Max retries reached");
      throw err;
    }
  }
}
