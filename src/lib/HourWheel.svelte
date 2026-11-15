<script lang="ts">
  import { onMount } from 'svelte';

  /** "Ile godzin temu?": a wheel of 1 to 24 hours that snaps to the hour under the centre band. */
  let { value, label, onchange, t } = $props<{
    value: number;
    label: string;
    onchange: (hours: number) => void;
    t: (text: string) => string;
  }>();

  const hours = Array.from({ length: 24 }, (_, index) => index + 1);
  const row = 56;
  let wheel = $state<HTMLDivElement>();
  let shown = $state(1);
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The first state comes from the Draft once; afterwards the wheel's own scroll is the truth.
  onMount(() => {
    shown = Math.min(24, Math.max(1, value));
    if (wheel) wheel.scrollTop = (shown - 1) * row;
    // It opens under the answers; once its reveal has finished growing, bring the whole wheel into view.
    const reveal = setTimeout(() => wheel?.closest('.hour-wheel')?.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' }), 220);
    return () => { clearTimeout(settleTimer); clearTimeout(reveal); };
  });

  // While the wheel glides to a key press or tap, the scroll it makes on the way is not the Reporter's choice.
  let aiming: number | undefined;
  function scrollTo(next: number) {
    const target = Math.min(24, Math.max(1, next));
    aiming = target;
    wheel?.scrollTo({ top: (target - 1) * row, behavior: reduced() ? 'auto' : 'smooth' });
    shown = target;
    onchange(target);
  }
  function scrolled() {
    if (!wheel) return;
    const under = Math.min(24, Math.max(1, Math.round(wheel.scrollTop / row) + 1));
    if (aiming !== undefined) { if (under === aiming && Math.abs(wheel.scrollTop - (aiming - 1) * row) < 1) aiming = undefined; return; }
    shown = under;
    // Commit once the wheel has come to rest on an hour, not at every pixel of the swipe.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { if (shown !== value) onchange(shown); }, 120);
  }
  function key(event: KeyboardEvent) {
    const by = { ArrowUp: -1, ArrowDown: 1, PageUp: -6, PageDown: 6 }[event.key];
    if (by === undefined && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    scrollTo(event.key === 'Home' ? 1 : event.key === 'End' ? 24 : (aiming ?? shown) + by!);
  }
</script>

<div class="hour-wheel">
  <span class="label" id="hour-wheel-label">{label}</span>
  <div class="frame">
    <div id="when-detail" class="wheel" bind:this={wheel} role="spinbutton" tabindex="0" aria-labelledby="hour-wheel-label"
      aria-valuemin={1} aria-valuemax={24} aria-valuenow={shown} aria-valuetext={`${shown}${t(' godz.')}`}
      onscroll={scrolled} onkeydown={key}>
      {#each hours as hour (hour)}
        <button type="button" tabindex="-1" aria-hidden="true" class:current={hour === shown} onclick={() => scrollTo(hour)}>{hour}{t(' godz.')}</button>
      {/each}
    </div>
    <span class="band" aria-hidden="true"></span>
  </div>
</div>

<style>
  .hour-wheel { margin: 8px 0; }
  .label { display: block; font-weight: 600; margin-bottom: 6px; }
  /* Three rows show: the chosen hour in the band, one either side. */
  .frame { position: relative; height: 168px; border: 1px solid var(--ink); background: var(--paper); }
  .wheel { position: relative; z-index: 1; height: 100%; overflow-y: auto; scroll-snap-type: y mandatory; overscroll-behavior: contain; padding-block: 56px;
    scrollbar-width: none; mask-image: linear-gradient(transparent, #000 34%, #000 66%, transparent); }
  .wheel::-webkit-scrollbar { display: none; }
  .wheel:focus-visible { outline: none; }
  .frame:has(.wheel:focus-visible) { outline: 3px solid var(--focus); outline-offset: 2px; }
  .wheel button { display: block; width: 100%; height: 56px; min-height: 56px; scroll-snap-align: center; border: 0; border-radius: 0;
    background: transparent; padding: 0; font-size: 1.3rem; line-height: 1.2; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--muted);
    transition: color 120ms ease-out; }
  .wheel button:hover:enabled { background: transparent; }
  .wheel button.current { color: var(--ink); }
  .band { position: absolute; inset-inline: 8px; top: 56px; height: 56px; border-block: 2px solid var(--action);
    pointer-events: none; z-index: 0; }
  @media (prefers-reduced-motion: reduce) { .wheel button { transition: none; } }
</style>
