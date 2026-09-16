export const SVG_FINGERPRINT = 'b2cbbef5cd8d6a0d4d5ea076f8b99714';

// the icons the standalone webchat bundle needs - the widget's own plus those
// of the chat elements it renders. This is the usage file for the webchat
// sprite (bun run svg-wc), which the bundle inlines because a page on another
// site can't reference the platform's sprite cross-origin.
export enum WebChatIcon {
  send = 'send-03',
  close = 'x',
  progress_spinner = 'refresh-cw-04',
  up = 'chevron-up',
  log = 'file-02',
  download = 'download-01',
  attachment = 'paperclip',
  attachment_audio = 'volume-min',
  attachment_document = 'file-06',
  attachment_image = 'image-01',
  attachment_location = 'marker-pin-01',
  attachment_video = 'video-recorder',
  webchat = 'message-chat-circle'
}
