# Add to frontend/src/styles/global.css

Append this to the end of `global.css` (all scoped under `.site`, so admin theme
is untouched):

```css
/* ── Delivery subscription ─────────────────────────────────────────────────── */
.subscribe { max-width: 640px; }
.channel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 20px 0; }
.channel-card {
  background: var(--surface); border: 2px solid var(--border); border-radius: var(--radius);
  padding: 20px 16px; text-align: center; cursor: pointer; transition: all 0.15s;
  font-family: ui-sans-serif, system-ui, sans-serif;
}
.channel-card:hover { border-color: var(--muted); }
.channel-card.on { border-color: var(--accent); background: var(--accent-dim); }
.channel-icon { font-size: 28px; margin-bottom: 8px; }
.channel-name { font-weight: 600; font-size: 15px; }
.channel-desc { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
.subscribe-fields { margin: 20px 0; display: flex; flex-direction: column; gap: 16px; }
.subscribe-fields .field label { display: block; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.subscribe-fields .input { width: 100%; }
.subscribe-check { display: flex; align-items: center; gap: 8px; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 14px; color: var(--muted); }
```

# Wire the route

In `frontend/src/App.tsx`, add the import and route alongside the other public
site routes (inside the `<Route element={<SiteLayout />}>` block):

```tsx
import { SubscribePage } from './site/Subscribe';
// ...
          <Route path="/subscribe" element={<SubscribePage />} />
```
