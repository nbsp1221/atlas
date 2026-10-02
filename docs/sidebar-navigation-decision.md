# Sidebar current-page clarity

## Observed problem

Reproduced against the existing built preview on 2026-09-30 at 390 × 844. On `/automations/email-summary`, Email Code Steps had a subtle gray fill and weight 500 versus regular-weight inactive rows. Both that automation and the Automations index had `aria-current="page"`, although only the automation had `data-active`. Clicking a destination left the mobile drawer open.

## Primary guidance reviewed

- [shadcn Sidebar (Base UI)](https://ui.shadcn.com/docs/components/base/sidebar): its `isActive` state and custom render link are the existing supported pattern. The project actually uses Base UI; [the Radix variant](https://ui.shadcn.com/docs/components/radix/sidebar) has the same active-item concept. No component-library replacement is needed.
- [MDN aria-current](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current): expose the visually current page and mark only one item current in a related set.
- [WCAG 1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html): selection needs another visual cue besides color.
- [WCAG 1.4.3 Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): normal text needs at least 4.5:1 contrast.

## Smallest coherent change

Use the existing `sidebar-accent` / `sidebar-accent-foreground` pair that shadcn uses for sidebar hover and selected items. Tune only the existing accent surface values in `globals.css`: neutral `oklch(0.32 0 0)` in dark mode and `oklch(0.922 0 0)` in light mode. Keep their existing paired foreground values. This makes the filled row clearer while fitting the surrounding neutral surfaces. No new CSS variables or hardcoded component colors are introduced. A semibold label and short inset marker identify the current row without depending only on hue. Hover uses the same semantic accent, and the selected marker/weight distinguish selection from hover. An offset focus ring remains separate. Grouping, labels, icons, width, layout, and application workflows remain unchanged.

The neutral sidebar-accent pair keeps selection consistent with the interface
without introducing another token or changing the global brand palette.
[shadcn Theming](https://ui.shadcn.com/docs/theming) documents semantic
surface/foreground pairs and CSS-variable customization; sidebar-accent is for
hover and selected rows.

Use one pathname matcher for both `data-active` and `aria-current`. Overview and the Automations index require an exact path; automation links and section links use segment-bounded matching. Query strings/hash do not change current navigation. Trailing slash is accepted by the router matcher. Links use normal React Router navigation, preserving modifier-key behavior. A normal selection closes the mobile sheet, including same-page selection; location-key changes also dismiss it after browser Back/Forward.

During keyboard checks, hidden tooltips consumed Escape before the sheet could dismiss. The shared menu component now mounts tooltips only in desktop icon-only mode, where they are actually useful. Mobile and expanded desktop links remain normal links without invisible tooltip behavior.

## Verification evidence

`apps/web/tests/sidebar-navigation.spec.ts` covers mobile selection across every destination; exact index selection; automation and trailing-slash/query/hash routes; one current item; same-page close; Back/Forward while the sheet is open; keyboard Enter/Escape/focus; selected hover; desktop icon-only mode; rendered text/background contrast; and the non-color marker, in both existing light and dark themes. Rendered colors are checked against the actual sidebar-accent token pair.

Run `pnpm verify:local` to reproduce these checks with fresh isolated databases
and native HTTPS. The gate never uses the running preview for mutations; generated
screenshots and results remain in ignored, run-specific verification directories.
