export interface SessionDevice {
  id: string;
  label: string;
}

export interface DeviceList {
  videoinput: readonly SessionDevice[];
  audioinput: readonly SessionDevice[];
  audiooutput: readonly SessionDevice[];
  videooutput?: readonly SessionDevice[];
}

export interface DeviceSelection {
  current: string | null;
  pending: string | null;
  paused: boolean;
}

export interface DeviceState {
  videoinput: DeviceSelection;
  audioinput: DeviceSelection & { echoCancellation: boolean; noiseSuppression: boolean };
  audiooutput: DeviceSelection;
}
