// Reusable scoring-ruleset editor (vanilla, no framework). Used by the lobby
// rules panel and the sandbox. Renders a mode selector, the mode-relevant global
// params, and a searchable, tier-grouped pattern list with enable toggles + a
// value field bound to faan-or-points by the active mode. Calls onChange(ruleset)
// on every edit. The server sanitizes whatever this produces.
//
// Pattern categories (from the catalog):
//   - normal : toggle ⇒ ruleset.patterns[id].enabled
//   - special (seven pairs / thirteen orphans): toggle ⇒ allow flag + enabled
//   - knitted: toggle ⇒ allow flag only
// The value field always writes ruleset.patterns[id].faan / .points.
(function () {
  const clone = o => JSON.parse(JSON.stringify(o));
  const el = (tag, props, kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(c => c && n.appendChild(c));
    return n;
  };

  function createRulesetEditor(container, catalog, initial, onChange, opts) {
    opts = opts || {};
    let ruleset = clone(initial);
    if (!ruleset.patterns) ruleset.patterns = {};
    if (!ruleset.allow) ruleset.allow = { sevenPairs: true, thirteenOrphans: true, greaterKnitted: false, lesserKnitted: false, knittedStraight: false };

    const byTier = {};
    for (const p of catalog.patterns) {
      const tier = p.mcrPoints || 0;
      (byTier[tier] ??= []).push(p);
    }
    const tiers = Object.keys(byTier).map(Number).sort((a, b) => b - a);

    const isMcr = () => ruleset.mode === 'mcr-additive';
    const fire = () => onChange && onChange(clone(ruleset));

    function patternEnabled(p) {
      if (p.knitted) return ruleset.allow?.[p.allowFlag] === true;
      if (p.special) return ruleset.allow?.[p.allowFlag] !== false;
      return ruleset.patterns?.[p.id]?.enabled ?? p.defaultEnabled;
    }
    function patternValue(p) {
      const o = ruleset.patterns?.[p.id] || {};
      if (isMcr()) return o.points != null ? o.points : p.mcrPoints;
      return o.faan != null ? o.faan : p.hkFaan;
    }
    function setEnabled(p, on) {
      ruleset.patterns[p.id] = ruleset.patterns[p.id] || {};
      if (p.knitted) { ruleset.allow[p.allowFlag] = on; }
      else if (p.special) { ruleset.allow[p.allowFlag] = on; ruleset.patterns[p.id].enabled = on; }
      else { ruleset.patterns[p.id].enabled = on; }
      fire();
    }
    function setValue(p, v) {
      ruleset.patterns[p.id] = ruleset.patterns[p.id] || {};
      ruleset.patterns[p.id][isMcr() ? 'points' : 'faan'] = v;
      fire();
    }

    // ── Render ──
    container.innerHTML = '';
    container.classList.add('rs-editor');

    // Preset + mode row
    const presetSel = el('select', { class: 'rs-input' });
    presetSel.appendChild(el('option', { value: '', text: 'Presets…' }));
    Object.values(catalog.presets).forEach(pr => presetSel.appendChild(el('option', { value: pr.id, text: pr.name })));
    (opts.savedPresets || []).forEach(sp => presetSel.appendChild(el('option', { value: 'saved:' + sp.id, text: '★ ' + sp.name })));
    presetSel.addEventListener('change', () => {
      const v = presetSel.value;
      if (!v) return;
      if (v.startsWith('saved:')) {
        const sp = (opts.savedPresets || []).find(s => 'saved:' + s.id === v);
        if (sp) loadRuleset(sp.ruleset);
      } else if (catalog.presets[v]) {
        loadRuleset(catalog.presets[v]);
      }
      presetSel.value = '';
    });

    const modeSel = el('select', { class: 'rs-input' });
    catalog.modes.forEach(m => modeSel.appendChild(el('option', { value: m.id, text: m.name })));
    modeSel.value = ruleset.mode;
    modeSel.addEventListener('change', () => { ruleset.mode = modeSel.value; render(); fire(); });

    const globals = el('div', { class: 'rs-globals' });
    const list = el('div', { class: 'rs-list' });
    const search = el('input', { class: 'rs-input', placeholder: 'Search patterns…' });
    search.addEventListener('input', () => renderList(search.value.toLowerCase()));

    const header = el('div', { class: 'rs-row rs-head' }, [
      el('div', { class: 'rs-cell', text: 'Preset' }, [presetSel]),
      el('div', { class: 'rs-cell', text: 'Mode' }, [modeSel]),
    ]);
    container.append(header, globals, search, list);

    function numField(label, get, set, min, max) {
      const inp = el('input', { class: 'rs-input rs-num', type: 'number', value: get(), min: String(min), max: String(max) });
      inp.addEventListener('change', () => { const n = Math.round(Number(inp.value)); if (Number.isFinite(n)) { set(Math.min(max, Math.max(min, n))); } });
      return el('label', { class: 'rs-glabel', text: label }, [inp]);
    }

    function renderGlobals() {
      globals.innerHTML = '';
      if (ruleset.mode === 'mcr-additive') {
        ruleset.mcr = ruleset.mcr || { minPoints: 8, base: 8, basePoints: 1 };
        globals.append(
          numField('Min points', () => ruleset.mcr.minPoints, v => { ruleset.mcr.minPoints = v; fire(); }, 0, 88),
          numField('Base', () => ruleset.mcr.base, v => { ruleset.mcr.base = v; fire(); }, 0, 100),
          numField('Stake ×', () => ruleset.mcr.basePoints, v => { ruleset.mcr.basePoints = v; fire(); }, 1, 1000),
        );
      } else if (ruleset.mode === 'hk-grouped') {
        ruleset.grouped = ruleset.grouped || { breakpoints: [3, 5, 8, 11], basePoints: 1 };
        const bpInput = el('input', { class: 'rs-input', value: ruleset.grouped.breakpoints.join(', ') });
        bpInput.addEventListener('change', () => {
          const bp = bpInput.value.split(',').map(s => Math.round(Number(s.trim()))).filter(n => Number.isFinite(n) && n > 0);
          if (bp.length) { ruleset.grouped.breakpoints = bp; fire(); }
        });
        globals.append(
          el('label', { class: 'rs-glabel', text: 'Tier breakpoints' }, [bpInput]),
          numField('Stake ×', () => ruleset.grouped.basePoints, v => { ruleset.grouped.basePoints = v; fire(); }, 1, 10000),
          numField('Min faan', () => ruleset.hk.minFaan, v => { ruleset.hk.minFaan = v; fire(); }, 0, 26),
        );
      } else {
        ruleset.hk = ruleset.hk || { minFaan: 0, limitFaan: 13, basePoints: 1 };
        globals.append(
          numField('Min faan', () => ruleset.hk.minFaan, v => { ruleset.hk.minFaan = v; fire(); }, 0, 26),
          numField('Limit faan', () => ruleset.hk.limitFaan, v => { ruleset.hk.limitFaan = v; fire(); }, 1, 26),
          numField('Stake ×', () => ruleset.hk.basePoints, v => { ruleset.hk.basePoints = v; fire(); }, 1, 10000),
        );
      }
    }

    function renderList(filter) {
      list.innerHTML = '';
      const unit = isMcr() ? 'pts' : 'faan';
      for (const tier of tiers) {
        const rows = byTier[tier].filter(p => !filter || p.name.toLowerCase().includes(filter) || (p.cn || '').includes(filter) || p.id.includes(filter));
        if (!rows.length) continue;
        list.appendChild(el('div', { class: 'rs-tier', text: tier ? `${tier}-point tier` : 'Other' }));
        for (const p of rows) {
          const chk = el('input', { type: 'checkbox' });
          chk.checked = patternEnabled(p);
          chk.addEventListener('change', () => setEnabled(p, chk.checked));
          const val = el('input', { class: 'rs-input rs-num', type: 'number', value: patternValue(p), min: '0', max: '999' });
          val.addEventListener('change', () => { const n = Math.round(Number(val.value)); if (Number.isFinite(n)) setValue(p, Math.max(0, n)); });
          list.appendChild(el('div', { class: 'rs-row' }, [
            el('label', { class: 'rs-cell rs-toggle' }, [chk, el('span', { text: ` ${p.name} ` }), el('span', { class: 'rs-cn', text: p.cn || '' })]),
            el('div', { class: 'rs-cell rs-valcell' }, [val, el('span', { class: 'rs-unit', text: unit })]),
          ]));
        }
      }
    }

    function render() { modeSel.value = ruleset.mode; renderGlobals(); renderList(search.value.toLowerCase()); }
    function loadRuleset(rs) { ruleset = clone(rs); if (!ruleset.patterns) ruleset.patterns = {}; if (!ruleset.allow) ruleset.allow = {}; render(); fire(); }

    render();
    return {
      getRuleset: () => clone(ruleset),
      setRuleset: loadRuleset,
      setSavedPresets: (sps) => {
        opts.savedPresets = sps;
        [...presetSel.querySelectorAll('option')].filter(o => o.value.startsWith('saved:')).forEach(o => o.remove());
        (sps || []).forEach(sp => presetSel.appendChild(el('option', { value: 'saved:' + sp.id, text: '★ ' + sp.name })));
      },
    };
  }

  window.createRulesetEditor = createRulesetEditor;
})();
