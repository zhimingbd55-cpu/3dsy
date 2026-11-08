/** Shared capture, publishing and recording budget. No provider model change. */
export const VIDEO_PROFILE = {
  version: 'smooth-v2',
  camera: {portraitWidth:480, portraitHeight:640, fps:20},
  canvas: {width:360, height:640, fps:20},
  primary: {bitrate:700000, fps:20},
  secondary: {width:180, height:320, bitrate:150000, fps:15},
  reduced: {fps:15, primaryBitrate:500000, secondaryBitrate:100000},
  recorder: {original:450000, result:1200000},
  startPrimaryBitrate:400000,
} as const;
