import first from '../../data/rule-sets/2018-04-01.json' with { type: 'json' };
import second from '../../data/rule-sets/2019-03-01.json' with { type: 'json' };
import third from '../../data/rule-sets/2021-07-23.json' with { type: 'json' };
import fourth from '../../data/rule-sets/2022-04-01.json' with { type: 'json' };
import fifth from '../../data/rule-sets/2022-07-02.json' with { type: 'json' };
import sixth from '../../data/rule-sets/2022-11-16.json' with { type: 'json' };
import current from '../../data/rule-sets/2026-09-24-v2.json' with { type: 'json' };
import type { FindingsResult, Report } from './report.js';
import type { NoticeRuleSet } from './notice-composer.js';
import { warsawDate } from './time-findings.js';

const rules = [first, second, third, fourth, fifth, sixth, current] as NoticeRuleSet[];

export function findingRuleSet(id: string): NoticeRuleSet | undefined {
  return rules.find(rule => rule.id === id || `${rule.id}-protected-v1` === id);
}

export function noticeRuleSet(report: Report, findings: FindingsResult): NoticeRuleSet {
  if (findings.status === 'computed') {
    // Protected revisions add only protected_areas policy; Findings carries that policy with its citation.
    const matched = findingRuleSet(findings.rule_set_id);
    if (!matched) throw new Error('unknown_notice_rule_set');
    return matched;
  }
  const date = warsawDate(new Date(report.occurred_at.at));
  const matched = rules.filter(rule => rule.effective_from <= date)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.published_at.localeCompare(a.published_at))[0];
  return matched ?? rules[0];
}
