import type { Page } from '@playwright/test';
export const targetFloor: number;
export function untilSettled(page: Page): Promise<unknown>;
export function undersizedTargets(page: Page, floor?: number): Promise<string[]>;
export function assertEffectiveTargets(page: Page, label?: string): Promise<void>;
