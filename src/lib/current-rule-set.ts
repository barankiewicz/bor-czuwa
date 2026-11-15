import rule from '../../data/rule-sets/2026-09-24-v2.json';
import type { RuleSet } from './time-findings.ts';

const currentRuleSet = rule as RuleSet;

export const species = Object.entries(currentRuleSet.species)
  .map(([code, value]) => [code, value.label] as const);
