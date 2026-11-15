<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';

  let { open = $bindable(false), children, t, onopen } = $props<{
    open?: boolean;
    children: Snippet;
    onopen?: () => void;
    t: (text: string) => string;
  }>();
  const id = $props.id();

  function revealMap(node: HTMLElement) {
    const content = node.firstElementChild as HTMLElement;
    return {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200,
      easing: cubicOut,
      // Tile failures can add a message during opening. Measure the inner content each
      // frame so the reveal follows its current height instead of jumping at the end.
      tick: (progress: number) => {
        node.style.height = progress === 1 ? '' : `${content.offsetHeight * progress}px`;
        node.style.opacity = String(progress);
        node.style.overflow = progress === 1 ? '' : 'hidden';
      }
    };
  }
</script>

<div class="map-disclosure">
  <button type="button" aria-expanded={open} aria-controls={open ? id : undefined}
    onclick={() => { if (!open) onopen?.(); open = !open; }}>{t(open ? 'Ukryj mapę' : 'Pokaż mapę')}</button>
  {#if open}<div {id} transition:revealMap><div class="map-content">{@render children()}</div></div>{/if}
</div>

<style>
  .map-disclosure { margin-block: 16px; }
  .map-content { display: flow-root; }
  button { min-height: 56px; }
</style>
