import type { Services } from './lead/pipeline.ts';

const notReady = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} is not connected yet.`);
};

// Used until each account is connected, so nothing can leave by accident.
export const notConnected: Services = {
  sendEmail: notReady('Gmail'),
  wasSent: async () => false,
  sendText: notReady('Twilio'),
  findPhotos: notReady('Firecrawl'),
  writeGreeting: notReady('The language model'),
};

// Only for "Simulate a new lead" on your computer. Records nothing outside the app.
export const simulated: Services = {
  sendEmail: async () => {},
  wasSent: async () => false,
  sendText: async () => {},
  findPhotos: async () => ({ photos: [], pageUrl: '' }),
  writeGreeting: async () => '',
};
