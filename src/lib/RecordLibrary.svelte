<script module lang="ts">
  /** What a history row says beside its time: the Event, a place word if one is known, and where the Report stands. */
  export type ReportRow = { title: string; place?: string; lines: { text: string; tone: 'ink' | 'muted' | 'alert' }[] };
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { type LocalReport, type LocalWithdrawal } from './local-store';
  import type { Task } from './pending-work';
  import { reveal } from './reveal';
  import { icons } from './icons';
  import { warsawDate } from './time-findings';

  let { tasks, reports, withdrawals, t, when, reportRow, taskRow, result, notice, openReport, removeDraft, confirming = $bindable() }:
    { tasks: Task[]; reports: LocalReport[]; withdrawals: LocalWithdrawal[];
      t: (text: string) => string; when: (at: string) => { day: string; time: string; month: string; date: string; weekday: string };
      reportRow: (item: LocalReport) => ReportRow; taskRow: Snippet<[Task, string?, string?]>; result?: Snippet; notice?: Snippet;
      openReport: (item: LocalReport) => void; removeDraft: (id: string) => Promise<boolean>; confirming?: string } = $props();

  // A Withdrawal keeps its Report's id, so both can exist for a moment; keys carry the kind.
  type Entry = { id: string; at: string } & ({ kind: 'report'; item: LocalReport } | { kind: 'withdrawal' });
  /** Reports and Withdrawals by the Warsaw month they were saved in, newest first. */
  const months = $derived.by(() => {
    const entries: Entry[] = [
      ...reports.map(item => ({ kind: 'report' as const, id: item.report.id, at: item.report.captured_at, item })),
      ...withdrawals.map(item => ({ kind: 'withdrawal' as const, id: item.id, at: item.at }))
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const groups: { key: string; label: string; entries: Entry[] }[] = [];
    for (const entry of entries) {
      const key = warsawDate(new Date(entry.at)).slice(0, 7);
      if (groups.at(-1)?.key !== key) {
        const { month } = when(entry.at);
        groups.push({ key, label: month.charAt(0).toLocaleUpperCase() + month.slice(1), entries: [] });
      }
      groups.at(-1)!.entries.push(entry);
    }
    return groups;
  });

  const chevron = `<svg aria-hidden="true" viewBox="0 0 24 24">${icons['chevron-right']}</svg>`;

  function jumpToHistory() {
    const heading = document.getElementById('history-heading');
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  async function ask(id: string) {
    confirming = id;
    await tick();
    document.getElementById(`cancel-${id}`)?.focus();
  }
  export function cancel() {
    const id = confirming;
    confirming = undefined;
    if (id) document.getElementById(`delete-${id}`)?.focus();
  }
  let deleting = false;
  async function confirmDelete(id: string) {
    if (deleting) return;
    // Focus lands on the task that takes this one's place, else the one above, else the heading.
    // No scroll: the collapsing row carries the next task into view, a focus scroll would jump.
    const index = tasks.findIndex(task => task.id === id);
    const next = tasks[index + 1] ?? tasks[index - 1];
    deleting = true;
    try { if (!await removeDraft(id)) return; }
    finally { deleting = false; }
    confirming = undefined;
    await tick();
    (document.getElementById(next ? `task-${next.id}` : 'library-heading') as HTMLElement | null)?.focus({ preventScroll: true });
  }
</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && confirming) cancel(); }} />

<h1 id="library-heading" tabindex="-1">{t('Moje zapisy')}</h1>
{@render notice?.()}
{@render result?.()}
{#if months.length}<button class="wide" onclick={jumpToHistory}>{t('Przejdź do historii')}</button>{/if}
{#if tasks.length}<h2>{t('Do zrobienia')}</h2>{/if}
<div class="record-list">
  {#each tasks as task (task.id)}
    <div class="record-card" transition:reveal>
      {#if task.kind === 'draft'}
        {@const id = task.id}
        <div class="record-top">
          {@render taskRow(task, `task-${id}`)}
          <button id="delete-{id}" class="record-delete" aria-expanded={confirming === id} aria-describedby="title-task-{id} time-task-{id}" onclick={() => confirming === id ? cancel() : void ask(id)}>{t('Usuń')}<span class="sr-only">{t(' szkic')}</span></button>
        </div>
        {#if confirming === id}
          <div id="confirm-{id}" class="record-confirm" role="group" aria-labelledby="confirm-label-{id}" transition:reveal>
            <p id="confirm-label-{id}">{t('Usunąć szkic?')}</p>
            <div class="record-confirm-actions"><button id="cancel-{id}" onclick={cancel}>{t('Anuluj')}</button><button class="destructive" onclick={() => void confirmDelete(id)}>{t('Usuń')}</button></div>
          </div>
        {/if}
      {:else}
        {@render taskRow(task, `task-${task.id}`)}
      {/if}
    </div>
  {/each}
</div>
{#if months.length}
  <section class="history" aria-labelledby="history-heading" transition:reveal>
    <h2 id="history-heading" tabindex="-1">{t('Historia')}</h2>
    {#each months as group (group.key)}
      <div class="history-month" transition:reveal>
        <h3>{group.label}</h3>
        <ul>
          {#each group.entries as entry (`${entry.kind}:${entry.id}`)}
            {@const time = when(entry.at)}
            <li transition:reveal>
              <!-- The day leads each row in a ruled column, as dates do in a field book; the row's name already says it. -->
              {#snippet dateColumn()}<span class="date-col" aria-hidden="true"><b>{time.date}</b><span>{time.weekday}</span></span>{/snippet}
              {#if entry.kind === 'withdrawal'}
                <div class="record-static">{@render dateColumn()}<span class="record-copy"><strong>{t('Wycofane zgłoszenie')}</strong><small>{time.time} · {t('Usuwanie z serwera w toku')}</small></span></div>
              {:else}
                {@const row = reportRow(entry.item)}
                {@const id = `row-${entry.id}`}
                {@const place = row.place ? ` · ${row.place}` : ''}
                <button class="record-main" aria-label="{row.title}, {time.day} {time.time}{place}" aria-describedby="{id}-state" onclick={() => openReport(entry.item)}>{@render dateColumn()}<span class="record-copy"><strong>{row.title}</strong><small>{time.time}{place}</small><span id="{id}-state" class="record-state">{#each row.lines as line (line.text)}<small class="tone-{line.tone}" transition:reveal>{line.text}</small>{/each}</span></span>{@html chevron}</button>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </section>
{/if}
{#if !tasks.length && !reports.length && !withdrawals.length}<p>{t('Tu znajdziesz zapisane miejsca i zgłoszenia.')}</p>{/if}
