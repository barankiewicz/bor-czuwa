/// <reference types="vite/client" />

export const buildConfiguration = {
  mode: import.meta.env?.MODE ?? 'production',
  apiOrigin: import.meta.env?.VITE_API_ORIGIN ?? '',
  demoTestRecipient: import.meta.env?.VITE_DEMO_TEST_RECIPIENT ?? ''
};
