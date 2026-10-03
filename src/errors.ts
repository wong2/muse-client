export class MuseError extends Error {
  override name = 'MuseError';
}

export class MuseHttpError extends MuseError {
  override name = 'MuseHttpError';
  constructor(public readonly status: number, public readonly endpoint: string) {
    super(`Muse ${endpoint} returned HTTP ${status}`);
  }
}

export class MuseProtocolError extends MuseError {
  override name = 'MuseProtocolError';
}
