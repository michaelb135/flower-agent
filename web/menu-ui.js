/* A short meal request becomes an editable local shopping draft. */
(function (root) {
  'use strict';

  function create(options) {
    const H = root.TidyMenuHelper;
    const doc = root.document;
    const byId = id => doc.getElementById(id);
    const clone = value => JSON.parse(JSON.stringify(value));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const fields = {
      form: byId('quick-menu-form'), request: byId('quick-menu-request'), people: byId('quick-menu-people'),
      error: byId('quick-menu-error'), status: byId('quick-menu-status'), choices: byId('quick-menu-choices'),
      review: byId('quick-menu-review'), title: byId('quick-menu-draft-title'), assumptions: byId('quick-menu-assumptions'),
      reviewForm: byId('quick-menu-review-form'), items: byId('quick-menu-items'), remember: byId('quick-menu-remember'),
      approve: byId('quick-menu-approve'), continue: byId('quick-menu-continue'), reload: byId('quick-menu-reload'),
      preferences: byId('quick-menu-preferences'), forget: byId('quick-menu-forget'),
      shopping: byId('quick-menu-shopping-section'), shoppingTitle: byId('quick-menu-shopping-title'),
      shoppingStatus: byId('quick-menu-shopping-status'), shoppingItems: byId('quick-menu-shopping-items')
    };
    let loaded = null;
    let requestDirty = false;
    let reviewDirty = false;
    let committing = false;
    let conflict = false;
    let notice = '';
    let assumptions = [];
    let pending = null;
    let assistantPreparation = null;

    function current(state) { return H.validateState(state.menuHelper || H.emptyState()); }
    function error(message) {
      fields.error.textContent = message || '';
      fields.error.hidden = !message;
    }
    function element(tag, className, value) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (value !== undefined) node.textContent = value;
      return node;
    }
    function amountText(item) { return item.amount + ' ' + item.unit; }
    function productText(item) {
      const parts = [item.productName || item.name];
      if (item.store) parts.push(item.store);
      return parts.join(' · ');
    }
    function approvedDraft() {
      const menu = current(options.getState());
      if (reviewDirty || conflict || (loaded && !same(menu, loaded)) || !menu.draft || menu.draft.status !== 'approved') return null;
      return menu.draft;
    }
    function approvedItems() {
      const draft = approvedDraft();
      if (!draft) return [];
      const items = clone(draft.items.filter(item => item.included));
      return typeof options.visibleMealItems === 'function' ? clone(options.visibleMealItems(options.getState(), items)) : items;
    }
    function shoppingText() {
      const items = approvedItems();
      if (!items.length) return [];
      const draft = current(options.getState()).draft;
      return ['For ' + draft.name + ' (' + draft.people + ' people)', ...items.map(item =>
        '- ' + productText(item) + ': ' + amountText(item) + (item.url ? '\n  ' + item.url : '')
      )];
    }
    function refreshMessages() {
      const draft = loaded && loaded.draft;
      let message = notice;
      if (!message && draft) message = draft.status === 'approved' && !reviewDirty ? 'Shopping draft confirmed. No order has been placed.' : 'Ingredients filled in. Review the amounts, then confirm your shopping draft.';
      if (!message) message = 'Try a dish above. Ingredients come from Tidy’s simple recipe collection.';
      if (!options.getSaved()) message += ' Changes are not saved to this browser. Keep Tidy open and download a backup before closing.';
      fields.status.textContent = message;
      fields.reload.hidden = !conflict && !reviewDirty;
      fields.approve.disabled = conflict;
      fields.forget.disabled = conflict || reviewDirty;
      fields.approve.textContent = draft && draft.status === 'approved' && !reviewDirty ? 'Confirm shopping draft again' : 'Confirm shopping draft';
      fields.continue.hidden = !draft || draft.status !== 'approved' || reviewDirty || conflict;
    }
    function renderShopping() {
      const menu = current(options.getState());
      const draft = menu.draft;
      fields.shopping.hidden = !draft;
      if (!draft) { fields.shoppingItems.replaceChildren(); return; }
      fields.shoppingTitle.textContent = 'For ' + draft.name;
      const items = approvedItems();
      fields.shoppingItems.replaceChildren();
      if (!items.length) {
        fields.shoppingStatus.textContent = approvedDraft()
          ? 'These ingredients are already in your grocery list. No order has been placed.' + (options.getSaved() ? '' : ' This change is not saved; download a backup before closing Tidy.')
          : 'This meal is still a draft. Review and confirm its groceries in Menu before shopping.';
      } else {
        fields.shoppingStatus.textContent = 'Shopping draft confirmed for ' + draft.people + (draft.people === 1 ? ' person' : ' people') + '. No order has been placed.' + (options.getSaved() ? '' : ' This change is not saved; download a backup before closing Tidy.');
        items.forEach(item => {
          const row = element('li');
          const detail = element('div', 'quick-menu-shopping-product');
          detail.append(element('strong', '', productText(item)));
          if (item.productName) detail.append(element('small', 'helper', item.name));
          if (item.source) detail.append(element('small', 'quick-menu-source', item.source));
          if (item.url) {
            const open = element('button', 'button text small', 'Open product');
            open.type = 'button';
            open.addEventListener('click', () => options.openWebsite(item.url, item.productName || item.name));
            detail.append(open);
          }
          row.append(detail, element('span', '', amountText(item)));
          fields.shoppingItems.append(row);
        });
      }
      byId('quick-menu-kibsons').hidden = !items.length;
      byId('quick-menu-waitrose').hidden = !items.length;
    }
    function markReviewDirty() {
      cancelAssistantPreparation('You edited the meal ingredients instead of continuing that request.');
      reviewDirty = true;
      notice = 'You have changes to review. Your revised list needs confirmation before shopping.';
      refreshMessages();
      renderShopping();
    }
    function field(labelText, type, name, value, ingredient, attrs) {
      const label = element('label', 'quick-menu-product-field', labelText);
      const input = element(type === 'select' ? 'select' : 'input');
      input.dataset.field = name;
      input.id = 'quick-menu-' + ingredient + '-' + name;
      if (type === 'select') ['', 'Kibsons', 'Waitrose', 'Carrefour'].forEach(store => {
        const option = element('option', '', store || 'No shop chosen'); option.value = store; input.append(option);
      });
      else input.type = type;
      Object.entries(attrs || {}).forEach(([key, attribute]) => input.setAttribute(key, attribute));
      input.value = value;
      input.addEventListener('input', markReviewDirty);
      input.addEventListener('change', saveEdits);
      label.htmlFor = input.id;
      label.append(input);
      return label;
    }
    function renderItems(draft) {
      const openDetails = new Set(Array.from(fields.items.querySelectorAll('details[open]')).map(node => node.closest('[data-ingredient-id]').dataset.ingredientId));
      fields.items.replaceChildren();
      draft.items.forEach(item => {
        const row = element('li', 'quick-menu-item');
        row.dataset.ingredientId = item.ingredientId;
        const heading = element('div', 'quick-menu-item-heading');
        const include = element('label', 'check quick-menu-include');
        const checkbox = element('input');
        checkbox.type = 'checkbox'; checkbox.checked = item.included; checkbox.dataset.field = 'included';
        checkbox.addEventListener('input', markReviewDirty);
        checkbox.addEventListener('change', saveEdits);
        include.append(checkbox, element('span', '', item.name));
        heading.append(include, field('Amount (' + item.unit + ')', 'number', 'amount', item.amount, item.ingredientId, { min: '0.001', max: '1000000', step: 'any', inputmode: 'decimal' }));
        row.append(heading);
        const sourceText = item.source || (item.productName ? 'Your draft choice' : 'Suggested ingredient');
        const summaryText = item.productName ? item.productName + (item.store ? ' · ' + item.store : '') : 'Brand or shop (optional)';
        const details = element('details', 'quick-menu-product');
        details.open = openDetails.has(item.ingredientId);
        details.append(element('summary', '', summaryText));
        const productFields = element('div', 'quick-menu-product-fields');
        productFields.append(
          field('Product or brand', 'text', 'productName', item.productName, item.ingredientId, { maxlength: '160', autocomplete: 'off', placeholder: 'Optional — use your usual product' }),
          field('Shop', 'select', 'store', item.store, item.ingredientId),
          field('Product link (optional)', 'url', 'url', item.url, item.ingredientId, { maxlength: '2048', autocomplete: 'off', placeholder: 'https://…' })
        );
        details.append(productFields);
        row.append(element('p', 'helper quick-menu-source', sourceText), details);
        fields.items.append(row);
      });
    }
    function render() {
      // Parent persistence renders synchronously, including on a failed CAS.
      // Keep the editor intact until commit has learned which outcome occurred.
      if (committing) return;
      const menu = current(options.getState());
      if (loaded && same(menu, loaded)) { refreshMessages(); renderShopping(); return; }
      if (loaded && reviewDirty && !committing) {
        conflict = true;
        error('This meal changed in another tab. Your edits are still here. Load the saved draft before making more changes.');
        refreshMessages(); renderShopping(); return;
      }
      loaded = clone(menu);
      conflict = false;
      reviewDirty = false;
      fields.review.hidden = !menu.draft;
      if (!requestDirty) {
        fields.request.value = menu.draft ? menu.draft.request : '';
        fields.people.value = menu.draft ? menu.draft.people : menu.people;
      }
      if (menu.draft) {
        fields.title.textContent = menu.draft.name + ' — review your groceries';
        fields.assumptions.textContent = assumptions.length ? assumptions.join(' ') : menu.draft.people + (menu.draft.people === 1 ? ' person' : ' people') + '. Review amounts and remove anything you already have.';
        renderItems(menu.draft);
      } else fields.items.replaceChildren();
      fields.preferences.textContent = menu.preferences.length ? menu.preferences.length + ' product choice' + (menu.preferences.length === 1 ? '' : 's') + ' saved by you in Tidy. Retailer purchase history is not connected.' : 'No product choices saved yet. Tidy has not checked a retailer’s purchase history.';
      fields.forget.hidden = !menu.preferences.length;
      fields.remember.checked = false;
      refreshMessages(); renderShopping();
    }
    function commit(work, message, stateWork) {
      const baseline = clone(loaded || current(options.getState()));
      let failure = '';
      committing = true;
      const ok = options.mutate(state => {
        try {
          const latest = current(state);
          if (!same(latest, baseline)) throw new Error('This meal changed in another tab. Load the saved draft before trying again.');
          state.menuHelper = H.validateState(work(clone(latest)));
          if (stateWork) stateWork(state, state.menuHelper.draft);
        } catch (problem) { failure = problem.message; throw problem; }
      }, message);
      committing = false;
      if (!ok) {
        if (failure.includes('another tab')) conflict = true;
        notice = 'Your edits have not been applied. Review the problem and try again.';
        error(failure || 'That change could not be saved. Your entries are still here.');
        refreshMessages(); renderShopping();
        return false;
      }
      reviewDirty = false;
      error('');
      render();
      if (options.onChanged) options.onChanged();
      return true;
    }
    function readItems() {
      if (!loaded || !loaded.draft) return [];
      return loaded.draft.items.map(item => {
        const row = Array.from(fields.items.children).find(node => node.dataset.ingredientId === item.ingredientId);
        if (!row) throw new Error('Load the saved draft before editing this meal.');
        const value = name => row.querySelector('[data-field="' + name + '"]');
        const next = { ...item, amount: Number(value('amount').value), productName: value('productName').value,
          store: value('store').value, url: value('url').value, included: value('included').checked };
        if (next.productName !== item.productName || next.store !== item.store || next.url !== item.url) next.source = '';
        return next;
      });
    }
    function saveEdits() {
      if (!loaded || !loaded.draft) return false;
      let draft;
      try { draft = H.updateDraft(loaded.draft, { items: readItems() }); }
      catch (problem) { error(problem.message); refreshMessages(); return false; }
      const remember = fields.remember.checked;
      notice = 'Changes saved as a draft. Confirm your revised list before shopping.';
      if (!commit(menu => ({ ...menu, draft }), 'Meal groceries updated. Review before shopping.')) return false;
      fields.remember.checked = remember;
      return true;
    }
    function cancelAssistantPreparation(reason = 'The meal request was cancelled.') {
      const preparation = assistantPreparation;
      if (!preparation) return false;
      assistantPreparation = null;
      if (pending && pending.preparation === preparation) {
        pending = null;
        byId('quick-menu-replacement').hidden = true;
      }
      fields.choices.replaceChildren();
      fields.choices.hidden = true;
      if (options.onPreparationCancelled) options.onPreparationCancelled(preparation.context, reason);
      return true;
    }
    function preparationFailure(preparation, message) {
      if (preparation && options.onPreparationFailed) options.onPreparationFailed(preparation.context, message);
      return { status: 'error', message };
    }
    function acceptPrepared(result, preparation = null) {
      if (preparation && preparation !== assistantPreparation) return { status: 'cancelled', message: 'That meal request is no longer active.' };
      if (preparation && typeof options.applyPrepared !== 'function') return preparationFailure(preparation, 'The related meal actions are unavailable. Nothing new was changed.');
      assumptions = result.assumptions || [];
      notice = 'I’ve filled in the ingredients for ' + result.draft.name.toLowerCase() + '. Review the list, then confirm it. No order has been placed.';
      const oldDirty = requestDirty;
      requestDirty = false;
      let outcome;
      if (commit(menu => ({ ...menu, people: result.draft.people, draft: result.draft }), 'Meal ingredients prepared for review.', preparation ? (state, draft) => {
        outcome = options.applyPrepared(state, clone(draft), preparation.context);
      } : null)) {
        fields.title.focus();
        byId('quick-menu-replacement').hidden = true;
        pending = null;
        if (preparation) assistantPreparation = null;
        const prepared = { status: 'prepared', name: result.draft.name, draftId: result.draft.id, saved: options.getSaved(), ...(preparation ? { context: preparation.context, outcome } : {}) };
        if (options.onPrepared) options.onPrepared(prepared);
        return prepared;
      }
      requestDirty = oldDirty;
      return preparationFailure(preparation, fields.error.textContent);
    }
    function prepare(recipeId, recipeName, preparation = null) {
      if (preparation && preparation !== assistantPreparation) return { status: 'cancelled', message: 'That meal request is no longer active.' };
      if (!preparation) cancelAssistantPreparation('You started a different meal request.');
      error('');
      pending = null;
      byId('quick-menu-replacement').hidden = true;
      let result;
      try {
        result = H.createDraft(recipeName || fields.request.value, {
          people: Number(fields.people.value), preferences: (loaded || current(options.getState())).preferences,
          ...(recipeId ? { recipeId } : {})
        });
      } catch (problem) { error(problem.message); return preparationFailure(preparation, problem.message); }
      fields.choices.replaceChildren();
      fields.choices.hidden = result.ok;
      if (!result.ok) {
        notice = result.reason;
        const original = fields.request.value;
        const explicitShape = (original.match(/\b(?:spaghetti|penne)\b/i) || [''])[0];
        const explicitPeople = (original.match(/\bfor\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+(?:people|persons?|servings?))?\b/i) || [''])[0];
        fields.choices.append(element('p', 'helper', 'Choose one of these simple recipes instead. Only its listed ingredients will be included.'));
        result.choices.forEach(choice => {
          const button = element('button', 'button secondary small', choice.name);
          button.type = 'button';
          button.addEventListener('click', () => prepare(choice.id, [choice.name, explicitShape, explicitPeople].filter(Boolean).join(' '), preparation));
          fields.choices.append(button);
        });
        refreshMessages(); return { status: 'choices', message: result.reason };
      }
      if (loaded && loaded.draft) {
        pending = { result, baseline: clone(loaded), preparation };
        byId('quick-menu-replacement-message').textContent = 'Replace your current ' + loaded.draft.name.toLowerCase() + ' draft with ' + result.draft.name.toLowerCase() + '? Ingredients under the current meal will change. Items already added separately in Groceries will stay. You can view and download the current list first.';
        byId('quick-menu-replacement').hidden = false;
        byId('quick-menu-replace').focus();
        return { status: 'replacement', name: result.draft.name };
      }
      return acceptPrepared(result, preparation);
    }

    function prepareFromAssistant(request, context = null) {
      if (typeof request !== 'string' || !request.trim() || request.length > 1000) return { status: 'error', message: 'Name a simple dish to prepare its groceries.' };
      render();
      if (reviewDirty || conflict || pending || requestDirty && fields.request.value.trim() && fields.request.value.trim() !== request.trim()) {
        const message = 'Your unfinished meal entry is still here. Review it in Menu before starting another meal.';
        error(message);
        return { status: 'blocked', message };
      }
      cancelAssistantPreparation('You started a different assistant request.');
      const preparation = context === null ? null : { context };
      assistantPreparation = preparation;
      fields.request.value = request.trim();
      requestDirty = true;
      return prepare(undefined, undefined, preparation);
    }

    fields.form.addEventListener('submit', event => { event.preventDefault(); prepare(); });
    fields.request.addEventListener('input', () => { cancelAssistantPreparation('You edited the meal request.'); requestDirty = true; });
    fields.people.addEventListener('input', () => { cancelAssistantPreparation('You edited the number of people.'); if (loaded && loaded.draft && fields.request.value === loaded.draft.request) markReviewDirty(); });
    fields.people.addEventListener('change', () => {
      if (!loaded || !loaded.draft || fields.request.value !== loaded.draft.request) return;
      let draft;
      try {
        const edited = H.updateDraft(loaded.draft, { items: readItems() });
        draft = H.updateDraft(edited, { people: Number(fields.people.value) });
      }
      catch (problem) { error(problem.message); refreshMessages(); return; }
      assumptions = [];
      notice = 'Amounts updated for ' + draft.people + ' people. Review and confirm this revised draft.';
      const remember = fields.remember.checked;
      if (commit(menu => ({ ...menu, people: draft.people, draft }), 'Meal amounts updated.')) fields.remember.checked = remember;
    });
    doc.querySelectorAll('[data-quick-meal]').forEach(button => button.addEventListener('click', () => prepare(undefined, button.dataset.quickMeal)));
    fields.reviewForm.addEventListener('submit', event => {
      event.preventDefault();
      cancelAssistantPreparation('You confirmed the current meal instead of continuing that request.');
      if (!loaded || !loaded.draft) return;
      let draft;
      try {
        const edited = H.updateDraft(loaded.draft, { items: readItems() });
        const resized = H.updateDraft(edited, { people: Number(fields.people.value) });
        draft = H.approveDraft(resized);
      } catch (problem) { error(problem.message); return; }
      const remember = fields.remember.checked;
      notice = 'Shopping draft confirmed. You choose and pay for products on the shop’s website.';
      if (commit(menu => {
        const preferences = remember ? H.rememberPreferences(menu.preferences, draft) : menu.preferences;
        if (remember) draft.items = draft.items.map(item => ({ ...item, source: item.included && item.productName ? 'Saved by you in Tidy' : item.source }));
        return { ...menu, draft, preferences };
      }, 'Shopping draft confirmed. No order placed.')) options.showView('shopping');
    });
    fields.continue.addEventListener('click', () => options.showView('shopping'));
    byId('quick-menu-replace').addEventListener('click', () => {
      if (!pending) return;
      if (!same(pending.baseline, loaded)) {
        const message = 'The current meal changed. Prepare the new dish again before replacing it.';
        error(message); preparationFailure(pending.preparation, message); return;
      }
      acceptPrepared(pending.result, pending.preparation);
    });
    byId('quick-menu-keep').addEventListener('click', () => {
      cancelAssistantPreparation('Your current meal was kept; the other requested actions were not started.');
      pending = null; byId('quick-menu-replacement').hidden = true;
      if (loaded && loaded.draft) { fields.request.value = loaded.draft.request; fields.people.value = loaded.draft.people; requestDirty = false; }
      notice = 'Your current meal and groceries were kept.'; refreshMessages();
    });
    byId('quick-menu-view-current').addEventListener('click', () => options.showView('shopping'));
    fields.reload.addEventListener('click', () => {
      cancelAssistantPreparation('You loaded the saved meal instead of continuing that request.');
      reviewDirty = false; requestDirty = false; conflict = false; loaded = null; assumptions = [];
      pending = null; byId('quick-menu-replacement').hidden = true;
      notice = 'Showing the latest saved meal draft.'; error(''); render();
      if (options.onChanged) options.onChanged();
    });
    fields.forget.addEventListener('click', () => {
      cancelAssistantPreparation('You changed the saved product choices instead of continuing that request.');
      notice = 'Saved product choices removed. Existing draft choices remain editable.';
      commit(menu => ({ ...menu, preferences: [], draft: menu.draft ? { ...menu.draft, items: menu.draft.items.map(item => ({ ...item, source: '' })) } : null }), 'Saved product choices forgotten.');
    });
    byId('quick-menu-edit').addEventListener('click', () => { options.showView('meals'); fields.title.focus(); });
    byId('quick-menu-kibsons').addEventListener('click', () => options.openWebsite('https://www.kibsons.com/', 'Kibsons'));
    byId('quick-menu-waitrose').addEventListener('click', () => options.openWebsite('https://www.waitrose.ae/', 'Waitrose UAE'));

    return { render, getApprovedItems: approvedItems, shoppingText, prepareFromAssistant, cancelAssistantPreparation };
  }

  root.TidyQuickMenuUI = Object.freeze({ create });
})(typeof globalThis !== 'undefined' ? globalThis : this);
