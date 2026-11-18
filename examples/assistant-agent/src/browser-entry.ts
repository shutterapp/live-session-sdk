import { createCaptionMedia } from "@shutter-studio/caption-media/browser-entry";
import { installMatrixVideo } from "./matrix-video.js";

installMatrixVideo({ captioning: true });
window.studioMediaSource = createCaptionMedia(window.studioVideo);
