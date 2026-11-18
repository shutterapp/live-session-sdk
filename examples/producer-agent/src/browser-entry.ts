import { createCaptionMedia } from "@shutter-studio/caption-media/browser-entry";
import { producerVideo } from "./producer-video.js";

window.studioMediaSource = createCaptionMedia(producerVideo());
