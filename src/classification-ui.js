import { PALETTE, activeToken, suggestions, categoryToken, parseClassification, nameKey, updateCategory, categoryCount, removeCategory, matchesFilters } from './classification.js';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dot = (color) => `<span class="tag-dot" style="--category-color:${color}" aria-hidden="true"></span>`;
const label = (kind) => kind === 'projects' ? '项目' : '标签';
const isComposer = (el) => el?.matches?.('#main-input, #quick-input, #recur-input');

export function createClassificationUI({ getState, save, render, openSettings }) {
  const filters = { project: '', tags: [] };
  let popup = null, input = null, active = null, choices = [], selected = 0, composing = false;
  let currentOverlay = null;

  function cleanFilters() {
    const state = getState();
    if (filters.project && filters.project !== 'none' && !state.projects.some(p => p.id === filters.project)) filters.project = '';
    filters.tags = filters.tags.filter(id => state.tags.some(t => t.id === id));
  }
  function filtered(task) { cleanFilters(); return matchesFilters(task, filters); }
  function hasFilters() { cleanFilters(); return !!(filters.project || filters.tags.length); }
  function clearFilters() { filters.project = ''; filters.tags = []; render(); }
  function filterBar() {
    cleanFilters();
    const project = getState().projects.find(p => p.id === filters.project);
    const projectTitle = project?.name || (filters.project === 'none' ? '无项目' : '全部项目');
    const caret = '<span class="filter-caret" aria-hidden="true"><svg viewBox="0 0 10 6" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="1.5 1.5 5 4.8 8.5 1.5"/></svg></span>';
    return `<div class="filter-bar" aria-label="分类筛选">
      <button data-class-ui="filter-projects" class="filter-chip ${filters.project ? 'selected' : ''}" title="${esc(projectTitle)}">${project ? dot(project.color) : '<span>+</span>'}<span>${esc(projectTitle)}</span>${caret}</button>
      <button data-class-ui="filter-tags" class="filter-chip ${filters.tags.length ? 'selected' : ''}"><span>#</span><span>${filters.tags.length ? `标签 · ${filters.tags.length}` : '全部标签'}</span>${caret}</button>
      ${hasFilters() ? '<button data-class-ui="clear" class="filter-clear" aria-label="清除分类筛选" title="清除筛选">×</button>' : ''}
    </div>`;
  }
  function rowStyle(task) {
    const project = getState().projects.find(p => p.id === task.projectId);
    if (!project) return '';
    const rgb = project.color.slice(1).match(/../g).map(n => parseInt(n, 16)).join(',');
    return ` style="--project-rgb:${rgb}" data-project-color`;
  }
  function rowMetadata(task) {
    const tags = task.tagIds.map(id => getState().tags.find(t => t.id === id)).filter(Boolean);
    const project = getState().projects.find(p => p.id === task.projectId);
    if (!tags.length && !project) return '';
    return `<button class="task-categories" data-class-ui="task" data-task="${esc(task.id)}" aria-label="编辑项目与标签：${esc([project?.name, ...tags.map(t => t.name)].filter(Boolean).join('、'))}" title="${esc([project ? '项目：' + project.name : '', ...tags.map(t => '#' + t.name)].filter(Boolean).join(' · '))}">
      ${tags.slice(0, 4).map(t => `<span title="${esc(t.name)}">${dot(t.color)}</span>`).join('')}
      ${tags.length > 4 ? `<span class="tag-overflow">+${tags.length - 4}</span>` : ''}
      ${!tags.length && project ? `<span class="project-caption">${esc(project.name)}</span>` : ''}
    </button>`;
  }

  function showNotice(message, hidden = false) {
    document.querySelector('.classification-notice')?.remove();
    const notice = document.createElement('div'); notice.className = 'classification-notice'; notice.setAttribute('role', 'status');
    notice.innerHTML = `<span>${esc(message)}</span>${hidden ? '<button data-class-ui="clear">清除筛选查看</button>' : ''}<button aria-label="关闭提示">×</button>`;
    notice.lastElementChild.onclick = () => notice.remove();
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 6000);
  }

  function closeAutocomplete() {
    popup?.remove(); popup = null;
    if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-controls'); }
    input = null; active = null;
  }
  function positionPopup() {
    if (!popup || !input) return;
    const r = input.closest('.composer').getBoundingClientRect();
    const above = r.top - 12, below = innerHeight - r.bottom - 12;
    const up = above >= Math.min(220, below);
    popup.style.width = Math.min(Math.max(220, r.width), innerWidth - 24) + 'px';
    popup.style.left = Math.max(12, Math.min(r.left, innerWidth - popup.offsetWidth - 12)) + 'px';
    popup.style.maxHeight = Math.max(60, Math.min(250, up ? above : below)) + 'px';
    popup.style.top = up ? Math.max(8, r.top - popup.offsetHeight - 6) + 'px' : r.bottom + 6 + 'px';
  }
  function selectOption(index) {
    if (!input || !active || !choices[index]) return;
    const field = input, choice = choices[index];
    field.setRangeText(categoryToken(active.kind, choice.name) + ' ', active.start, active.end, 'end');
    closeAutocomplete(); field.dispatchEvent(new Event('input', { bubbles: true })); field.focus();
  }
  function highlight() {
    popup?.querySelectorAll('[role="option"]').forEach((el, i) => { el.setAttribute('aria-selected', String(i === selected)); if (i === selected) el.scrollIntoView({ block: 'nearest' }); });
    input?.setAttribute('aria-activedescendant', `category-option-${selected}`);
  }
  function updatePreview(field) {
    const wrapper = field.closest('.composer');
    let preview = wrapper.nextElementSibling;
    if (!preview?.classList.contains('classification-preview')) { preview = document.createElement('div'); preview.className = 'classification-preview'; wrapper.after(preview); }
    const tokens = parseClassification(field.value).tokens;
    const project = tokens.filter(t => t.kind === 'projects').at(-1);
    const tags = [...new Map(tokens.filter(t => t.kind === 'tags').map(t => [nameKey(t.name), t])).values()];
    preview.textContent = [project ? '+' + project.name : '', ...tags.map(t => '#' + t.name)].filter(Boolean).join('  ');
    preview.hidden = !preview.textContent;
  }
  function updateAutocomplete(field) {
    updatePreview(field);
    closeAutocomplete();
    if (composing || field.selectionStart !== field.selectionEnd) return;
    const token = activeToken(field.value, field.selectionStart);
    if (!token) return;
    input = field; active = token; choices = suggestions(getState(), active); selected = 0;
    popup = document.createElement('div'); popup.className = 'category-suggestions'; popup.id = 'category-suggestions'; popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', label(active.kind) + '候选');
    popup.innerHTML = choices.map((choice, index) => `<button role="option" aria-selected="${index === 0}" id="category-option-${index}" data-index="${index}">${dot(choice.color)}<span>${choice.create ? `新建「${esc(choice.name)}」` : esc(choice.name)}</span>${choice.create ? '<small>随任务保存</small>' : ''}</button>`).join('') || `<div class="suggestion-empty">输入名称即可新建${label(active.kind)}</div>`;
    field.setAttribute('role', 'combobox'); field.setAttribute('aria-autocomplete', 'list'); field.setAttribute('aria-expanded', 'true'); field.setAttribute('aria-controls', popup.id);
    if (choices.length) field.setAttribute('aria-activedescendant', 'category-option-0');
    popup.addEventListener('mousedown', e => e.preventDefault());
    popup.addEventListener('click', e => { const option = e.target.closest('[data-index]'); if (option) selectOption(Number(option.dataset.index)); });
    document.body.appendChild(popup); positionPopup();
  }

  function modal(title, body, back) {
    closeAutocomplete(); currentOverlay?.remove();
    const focused = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'overlay classification-overlay';
    overlay.innerHTML = `<section class="settings category-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="category-header">${back ? '<button class="icon-btn" data-panel="back" aria-label="返回设置">‹</button>' : ''}<h2>${esc(title)}</h2><button class="icon-btn" data-panel="close" aria-label="关闭">×</button></div>${body}<div class="category-error" role="alert"></div></section>`;
    function close() { overlay.remove(); if (currentOverlay === overlay) currentOverlay = null; if (focused?.isConnected) focused.focus(); }
    overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('[data-panel="close"]')) close(); if (e.target.closest('[data-panel="back"]')) { close(); back(); } });
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const els = [...overlay.querySelectorAll('button,input,select,textarea')].filter(el => !el.disabled && el.offsetParent !== null);
        if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0]?.focus(); }
      }
    });
    document.body.appendChild(overlay); currentOverlay = overlay; overlay.querySelector('button,input,select')?.focus();
    return overlay;
  }
  function openFilters(kind) {
    const state = getState();
    const body = kind === 'projects'
      ? `<div class="category-options">${[{ id: '', name: '全部项目' }, { id: 'none', name: '无项目' }, ...state.projects].map(p => `<button data-filter-project="${esc(p.id)}" class="category-option ${p.id === filters.project ? 'selected' : ''}">${p.color ? dot(p.color) : ''}<span>${esc(p.name)}</span>${p.id === filters.project ? '<span>✓</span>' : ''}</button>`).join('')}</div>`
      : `<p class="category-hint">显示匹配任一所选标签的任务</p><button class="link-btn" data-filter-all>全部标签</button><div class="category-options">${state.tags.map(t => `<label class="category-option"><input type="checkbox" value="${esc(t.id)}" ${filters.tags.includes(t.id) ? 'checked' : ''}>${dot(t.color)}<span>${esc(t.name)}</span></label>`).join('') || '<p class="category-hint">在任务中输入 #标签名 即可创建</p>'}</div><button class="data-btn" data-panel="close">完成</button>`;
    const overlay = modal('筛选' + label(kind), body);
    overlay.addEventListener('click', e => {
      const project = e.target.closest('[data-filter-project]');
      if (project) { filters.project = project.dataset.filterProject; overlay.remove(); render(); }
      if (e.target.closest('[data-filter-all]')) { filters.tags = []; overlay.remove(); render(); }
    });
    overlay.addEventListener('change', () => { filters.tags = [...overlay.querySelectorAll('input:checked')].map(el => el.value); render(); });
  }

  function metadataFields(task) {
    const state = getState();
    return `<div class="metadata-fields"><label class="category-field">项目<select data-metadata-project aria-label="任务项目"><option value="">无项目</option>${state.projects.map(p => `<option value="${esc(p.id)}" ${task.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label><div class="category-field">标签<div class="metadata-tags">${state.tags.map(t => `<label><input data-metadata-tag type="checkbox" value="${esc(t.id)}" ${task.tagIds.includes(t.id) ? 'checked' : ''}>${dot(t.color)}<span>${esc(t.name)}</span></label>`).join('') || '<span class="category-hint">输入 #标签名 可创建标签</span>'}</div></div></div>`;
  }
  function readMetadata(container) { return { projectId: container.querySelector('[data-metadata-project]').value || null, tagIds: [...container.querySelectorAll('[data-metadata-tag]:checked')].map(el => el.value) }; }
  function openTaskCategories(task) {
    const overlay = modal('任务分类', `<p class="category-hint">${esc(task.title)}</p>${metadataFields(task)}<button class="data-btn" data-save-metadata>保存</button>`);
    overlay.querySelector('[data-save-metadata]').onclick = () => { Object.assign(task, readMetadata(overlay)); save(); overlay.remove(); render(); if (!filtered(task)) showNotice('任务已保存，当前筛选未包含它', true); };
  }

  function openManager(kind = 'projects', returnToSettings = openSettings) {
    const state = getState();
    const body = `<div class="seg-control" aria-label="分类类型"><button data-kind="projects" class="${kind === 'projects' ? 'on' : ''}">项目</button><button data-kind="tags" class="${kind === 'tags' ? 'on' : ''}">标签</button></div>
      <p class="category-hint">${kind === 'projects' ? '项目颜色用于任务底色' : '标签颜色用于任务圆球'} · 修改后自动保存</p>
      <div class="category-list">${state[kind].map(entry => `<div class="category-entry" data-entry="${esc(entry.id)}"><div class="category-entry-main"><label class="category-color" title="修改颜色"><span class="sr-only">${esc(entry.name)}的颜色</span><input type="color" value="${entry.color}" data-entry-color></label><input class="category-name" aria-label="${label(kind)}名称" value="${esc(entry.name)}" data-entry-name><button class="icon-btn" data-entry-delete title="删除${label(kind)}" aria-label="删除${esc(entry.name)}">×</button></div><div class="category-entry-bottom"><span>${categoryCount(state, kind, entry.id)} 个任务</span><div class="category-palette">${PALETTE.map(color => `<button style="--category-color:${color}" class="palette-swatch" data-palette="${color}" aria-label="使用颜色 ${color}" title="${color}"></button>`).join('')}</div></div></div>`).join('') || `<div class="category-empty">还没有${label(kind)}<p>添加任务时输入 ${kind === 'projects' ? '+' : '#'}名称 即可创建</p></div>`}</div>`;
    const overlay = modal('项目与标签', body, returnToSettings);
    const error = overlay.querySelector('.category-error');
    const change = (id, values) => { try { updateCategory(getState(), kind, id, values); save(); render(); error.textContent = ''; return true; } catch (e) { error.textContent = e.message; return false; } };
    overlay.addEventListener('change', e => {
      const row = e.target.closest('[data-entry]'); if (!row) return;
      if (e.target.matches('[data-entry-name]')) {
        const ok = change(row.dataset.entry, { name: e.target.value });
        if (ok) { e.target.value = getState()[kind].find(t => t.id === row.dataset.entry).name; e.target.removeAttribute('aria-invalid'); }
        else e.target.setAttribute('aria-invalid', 'true');
      }
      if (e.target.matches('[data-entry-color]')) change(row.dataset.entry, { color: e.target.value });
    });
    overlay.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-entry-name]') && !e.isComposing) { e.preventDefault(); e.target.blur(); } });
    overlay.addEventListener('click', e => {
      const tab = e.target.closest('[data-kind]'); if (tab) { openManager(tab.dataset.kind, returnToSettings); return; }
      const row = e.target.closest('[data-entry]'); if (!row) return;
      const swatch = e.target.closest('[data-palette]');
      if (swatch && change(row.dataset.entry, { color: swatch.dataset.palette })) row.querySelector('[data-entry-color]').value = swatch.dataset.palette;
      if (e.target.closest('[data-entry-delete]')) {
        const id = row.dataset.entry, count = categoryCount(getState(), kind, id);
        const finish = (deleteTasks) => { removeCategory(getState(), kind, id, deleteTasks); cleanFilters(); save(); render(); openManager(kind, returnToSettings); };
        if (kind === 'tags' || count === 0) finish(false);
        else {
          const entry = getState().projects.find(p => p.id === id);
          const confirm = modal('删除项目', `<p class="category-hint">「${esc(entry.name)}」关联 ${count} 个任务，包含所有日期和每天常驻任务。</p><button class="data-btn" data-delete="keep">保留任务，仅删除项目</button><button class="data-btn danger" data-delete="tasks">同时删除 ${count} 个任务</button><button class="data-btn" data-delete="cancel">取消</button>`);
          confirm.addEventListener('click', e => { const button = e.target.closest('[data-delete]'); if (!button) return; if (button.dataset.delete === 'cancel') openManager(kind, returnToSettings); else finish(button.dataset.delete === 'tasks'); });
        }
      }
    });
  }

  document.addEventListener('click', e => {
    const button = e.target.closest('[data-class-ui]');
    if (button) {
      const action = button.dataset.classUi;
      if (action === 'clear') { clearFilters(); document.querySelector('.classification-notice')?.remove(); }
      if (action === 'filter-projects') openFilters('projects');
      if (action === 'filter-tags') openFilters('tags');
      if (action === 'task') {
        const state = getState(); const task = [...Object.values(state.itemsByDay).flat(), ...state.recurringItems].find(t => t.id === button.dataset.task);
        if (task) openTaskCategories(task);
      }
    }
    if (isComposer(e.target)) updateAutocomplete(e.target);
    else if (!e.target.closest('.category-suggestions')) closeAutocomplete();
  });
  document.addEventListener('input', e => { if (isComposer(e.target)) updateAutocomplete(e.target); });
  document.addEventListener('compositionstart', e => { if (isComposer(e.target)) { composing = true; closeAutocomplete(); } });
  document.addEventListener('compositionend', e => { if (isComposer(e.target)) { composing = false; updateAutocomplete(e.target); } });
  document.addEventListener('keyup', e => { if (isComposer(e.target) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateAutocomplete(e.target); });
  document.addEventListener('keydown', e => {
    if (!isComposer(e.target)) return;
    if (e.isComposing || composing || e.keyCode === 229) { if (e.key === 'Enter') e.stopImmediatePropagation(); return; }
    if (!popup || input !== e.target) return;
    if (['ArrowDown', 'ArrowUp'].includes(e.key) && choices.length) { e.preventDefault(); e.stopImmediatePropagation(); selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; highlight(); }
    else if ((e.key === 'Enter' && !e.shiftKey || e.key === 'Tab' && !e.shiftKey) && choices.length) { e.preventDefault(); e.stopImmediatePropagation(); selectOption(selected); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeAutocomplete(); }
  }, true);
  window.addEventListener('resize', closeAutocomplete);
  document.addEventListener('focusin', e => { if (!isComposer(e.target) && !e.target.closest('.category-suggestions')) closeAutocomplete(); });
  function afterRender() {
    closeAutocomplete();
    document.querySelectorAll('#main-input, #quick-input, #recur-input').forEach(field => { field.setAttribute('aria-label', field.id === 'recur-input' ? '每天待办输入，#标签，+项目' : '待办输入，#标签，+项目'); updatePreview(field); });
  }
  return { filters, filtered, hasFilters, clearFilters, filterBar, rowStyle, rowMetadata, metadataFields, readMetadata, openTaskCategories, openManager, showNotice, afterRender, closeAutocomplete, isComposing: () => composing };
}
