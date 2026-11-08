import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {VIDEO_PROFILE} from './src/video-profile.ts';
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({
  plugins: [{
    name: 'decart-dual-peer-compatibility',
    enforce: 'pre',
    transform(code, id) {
      if (id.replace(/\\/g, '/').endsWith('/@decartai/sdk/dist/realtime/media-channel.js')) {
        const marker='await room.connect(opts.url, opts.token, { autoSubscribe: false });';
        if(code.split(marker).length!==2)throw new Error('Review Decart RTC connection adapter after SDK update.');
        // LiveKit accepts RTCConfiguration here; the SDK wrapper does not expose
        // it yet. Keep one session-scoped room handle for adaptive sender tuning.
        let next=code.replace(marker,`await room.connect(opts.url, opts.token, { autoSubscribe: false, maxRetries: 0, peerConnectionTimeout: 20000, ...(globalThis.__amenIceServers?.length ? {rtcConfig:{iceServers:globalThis.__amenIceServers}} : {}) });\n\t\tglobalThis.__amenBindRtcRoom?.(room);`);
        const encodingMarker='videoEncoding: {\n\t\t\tmaxBitrate,\n\t\t\tmaxFramerate: REALTIME_CONFIG.livekit.defaultPublishFps\n\t\t},';
        if(next.split(encodingMarker).length!==2)throw new Error('Review default smooth simulcast layers after SDK update.');
        next=next.replace(encodingMarker,`${encodingMarker}\n\t\tvideoSimulcastLayers: [{width:${VIDEO_PROFILE.secondary.width},height:${VIDEO_PROFILE.secondary.height},encoding:{maxBitrate:${VIDEO_PROFILE.secondary.bitrate},maxFramerate:${VIDEO_PROFILE.secondary.fps}}}],`);
        const closeMarker='disconnect() {\n\t\tconst room = this.room;';
        if(next.split(closeMarker).length!==2)throw new Error('Review Decart RTC room cleanup adapter after SDK update.');
        next=next.replace(closeMarker,`${closeMarker}\n\t\tglobalThis.__amenBindRtcRoom?.(null);`);
        // The page owns this canvas stream and reuses it for the next try-on.
        // Room.disconnect defaults to stopping it, independently of the
        // stopLocalTrackOnUnpublish option. Close transport without ending input.
        const disconnectMarker='if (room) room.disconnect().catch(() => {});';
        if(next.split(disconnectMarker).length!==2)throw new Error('Review Decart input track ownership after SDK update.');
        next=next.replace(disconnectMarker,'if (room) room.disconnect(false).catch(() => {});');
        return {code:next,map:null};
      }
      if (id.replace(/\\/g, '/').endsWith('/@decartai/sdk/dist/realtime/observability/webrtc-stats.js')) {
        const fieldMarker='\tprevNackCountInbound = 0;';
        if(code.split(fieldMarker).length!==2)throw new Error('Review Decart frame-stat counter adapter after SDK update.');
        let next=code.replace(fieldMarker,`${fieldMarker}\n\tframeCounters = new Map();`);
        const resetMarker='this.prevNackCountInbound = 0;';
        if(next.split(resetMarker).length!==2)throw new Error('Review Decart frame-stat reset adapter after SDK update.');
        next=next.replace(resetMarker,`${resetMarker}\n\t\tthis.frameCounters.clear();`);
        const pairsMarker='const succeededPairs = [];\n\t\trawStats.forEach((report) => {';
        if(next.split(pairsMarker).length!==2)throw new Error('Review Decart candidate-pair index adapter after SDK update.');
        next=next.replace(pairsMarker,`const reportsById = new Map();\n\t\trawStats.forEach((report) => { if (report?.id) reportsById.set(report.id, report); });\n\t\tconst succeededPairs = [];\n\t\trawStats.forEach((report) => {`);
        const inboundMarker='const framesDecoded = r.framesDecoded ?? 0;';
        if(next.split(inboundMarker).length!==2)throw new Error('Review Decart inbound FPS adapter after SDK update.');
        next=next.replace(inboundMarker,`${inboundMarker}\n\t\t\t\tconst frameKey = "in:" + r.id;\n\t\t\t\tconst previousFrames = this.frameCounters.get(frameKey);\n\t\t\t\tconst framesPerSecond = typeof r.framesPerSecond === "number" ? r.framesPerSecond : previousFrames !== void 0 && elapsed > 0 ? Math.max(0, (framesDecoded - previousFrames) / elapsed) : null;\n\t\t\t\tthis.frameCounters.set(frameKey, framesDecoded);`);
        const outboundMarker='const framesEncoded = r.framesEncoded ?? 0;';
        if(next.split(outboundMarker).length!==2)throw new Error('Review Decart outbound FPS adapter after SDK update.');
        next=next.replace(outboundMarker,`${outboundMarker}\n\t\t\t\tconst frameKey = "out:" + r.id;\n\t\t\t\tconst previousFrames = this.frameCounters.get(frameKey);\n\t\t\t\tconst framesPerSecond = typeof r.framesPerSecond === "number" ? r.framesPerSecond : previousFrames !== void 0 && elapsed > 0 ? Math.max(0, (framesEncoded - previousFrames) / elapsed) : null;\n\t\t\t\tthis.frameCounters.set(frameKey, framesEncoded);`);
        const fpsMarker='framesPerSecond: r.framesPerSecond ?? 0';
        if(next.split(fpsMarker).length!==3)throw new Error('Review Decart missing-FPS adapter after SDK update.');
        next=next.replaceAll(fpsMarker,'framesPerSecond');
        const outboundFpsMarker='outboundVideo.framesPerSecond = r.framesPerSecond ?? 0;';
        if(next.split(outboundFpsMarker).length!==2)throw new Error('Review Decart simulcast FPS adapter after SDK update.');
        next=next.replace(outboundFpsMarker,'outboundVideo.framesPerSecond = framesPerSecond;');
        const getMarker='const c = rawStats.get(id);';
        if(next.split(getMarker).length!==2)throw new Error('Review Decart candidate-pair lookup adapter after SDK update.');
        next=next.replace(getMarker,'const c = reportsById.get(id);');
        return {code:next,map:null};
      }
      if (!id.replace(/\\/g, '/').endsWith('/@decartai/sdk/dist/realtime/config-realtime.js')) return;
      // SDK 0.2.8 does not expose LiveKit RoomOptions. Use LiveKit's supported
      // dual-peer mode: its single-peer join reconfigures an existing Chromium
      // connection with insertable streams and fails with InvalidModificationError.
      // Keep this narrow build-time adaptation reproducible after npm ci.
      const marker = 'dynacast: false';
      if (code.split(marker).length !== 2) throw new Error('Decart transport configuration changed; review compatibility adapter.');
      const minimumMarker='const MIN_VIDEO_BITRATE_BPS = 11e5;';
      const maximumMarker='const MAX_VIDEO_BITRATE_BPS = 35e5;';
      const lowerLayersMarker='const SIMULCAST_LOWER_LAYERS_BPS = 61e4;';
      if(code.split(minimumMarker).length!==2||code.split(maximumMarker).length!==2||code.split(lowerLayersMarker).length!==2)throw new Error('Review smooth-profile bandwidth constants after SDK update.');
      const fpsMarker='defaultPublishFps: 30';
      if(code.split(fpsMarker).length!==2)throw new Error('Review default Decart publishing frame rate after SDK update.');
      const endMarker='terminalEndReasons: ["moderation_violation", "insufficient_credits"],';
      if(code.split(endMarker).length!==2)throw new Error('Review terminal Decart session reasons after SDK update.');
      return { code: code.replace(marker, `${marker},\n\t\t\tsinglePeerConnection: false,\n\t\t\tstopLocalTrackOnUnpublish: false`).replace(minimumMarker,`const MIN_VIDEO_BITRATE_BPS = ${VIDEO_PROFILE.startPrimaryBitrate};`).replace(maximumMarker,`const MAX_VIDEO_BITRATE_BPS = ${VIDEO_PROFILE.primary.bitrate};`).replace(lowerLayersMarker,`const SIMULCAST_LOWER_LAYERS_BPS = ${VIDEO_PROFILE.secondary.bitrate};`).replace(fpsMarker,`defaultPublishFps: ${VIDEO_PROFILE.primary.fps}`).replace(endMarker,'terminalEndReasons: ["moderation_violation", "insufficient_credits", "site_key_limit"],'), map: null };
    },
  }],
  server: { host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: false, rollupOptions:{input:{main:resolve(root,'index.html'),share:resolve(root,'share.html')}} },
});
