/* Tidy's small, local recipe catalogue. It prepares editable grocery drafts.
 * It has no retailer access, purchase history, stock checks, or ordering code. */
(function (root) {
  'use strict';

  const STORES = ['', 'Kibsons', 'Waitrose', 'Carrefour'];
  const UNITS = ['g', 'ml', 'pieces', 'item'];
  const SOURCE = 'Saved by you in Tidy';
  const MAX_AMOUNT = 1000000;
  const INGREDIENTS = {
    pasta: ['Pasta', 'g'], tinnedTomatoes: ['Tinned chopped tomatoes', 'g'],
    freshTomatoes: ['Fresh tomatoes', 'g'], oliveOil: ['Olive oil', 'ml'],
    chicken: ['Chicken breast', 'g'], tuna: ['Tinned tuna', 'g'],
    courgette: ['Courgette', 'g'], carrots: ['Carrots', 'g'], rice: ['Rice', 'g'],
    eggs: ['Eggs', 'pieces'], bread: ['Bread', 'pieces'], milk: ['Milk', 'ml'],
    oats: ['Oats', 'g'], yogurt: ['Plain yogurt', 'g'], bananas: ['Bananas', 'pieces'],
    apples: ['Apples', 'pieces'], cheese: ['Cheese', 'g'], avocado: ['Avocado', 'pieces'],
    flour: ['Plain flour', 'g'], fish: ['Fish fillets', 'g'], potatoes: ['Potatoes', 'g'],
    pizzaBase: ['Pizza bases', 'pieces'], tortillas: ['Tortilla wraps', 'pieces'],
    cucumber: ['Cucumber', 'g'], mayonnaise: ['Mayonnaise', 'g']
  };
  const recipe = (id, name, meal, ingredients, keywords) => ({ id, name, meal, ingredients, keywords });
  // Amounts are per person, before cooking. These are simple starting recipes,
  // not a nutrition, allergy, or dietary advice service.
  const CATALOGUE = [
    recipe('tomato-pasta', 'Tomato pasta', 'dinner', [['pasta', 90], ['tinnedTomatoes', 150], ['oliveOil', 5]], ['tomato pasta', 'pasta tomato', 'tomato spaghetti', 'spaghetti tomato', 'tomato penne', 'penne tomato', 'pasta sauce', 'spaghetti sauce', 'pasta pomodoro', 'spaghetti pomodoro']),
    recipe('chicken-pasta', 'Chicken pasta', 'dinner', [['pasta', 90], ['chicken', 150], ['tinnedTomatoes', 100], ['oliveOil', 5]], ['chicken pasta', 'pasta chicken', 'chicken spaghetti', 'chicken penne', 'chicken tomato pasta', 'chicken tomato spaghetti', 'chicken tomato penne']),
    recipe('tuna-pasta', 'Tuna pasta', 'lunch', [['pasta', 90], ['tuna', 80], ['tinnedTomatoes', 100], ['oliveOil', 5]], ['tuna pasta', 'pasta tuna', 'tuna spaghetti', 'tuna penne', 'tuna tomato pasta', 'tuna tomato spaghetti', 'tuna tomato penne']),
    recipe('vegetable-pasta', 'Vegetable pasta', 'dinner', [['pasta', 90], ['courgette', 100], ['carrots', 60], ['tinnedTomatoes', 100], ['oliveOil', 5]], ['vegetable pasta', 'veggie pasta', 'veg pasta', 'vegetable spaghetti', 'vegetable tomato pasta', 'veggie tomato pasta', 'veg tomato pasta']),
    recipe('scrambled-eggs-toast', 'Scrambled eggs on toast', 'breakfast', [['eggs', 2], ['bread', 2], ['milk', 20], ['oliveOil', 3]], ['scrambled eggs', 'eggs toast', 'egg toast', 'eggs on toast']),
    recipe('fried-eggs-toast', 'Fried eggs on toast', 'breakfast', [['eggs', 2], ['bread', 2], ['oliveOil', 5]], ['fried eggs', 'fried egg toast']),
    recipe('porridge', 'Banana porridge', 'breakfast', [['oats', 50], ['milk', 200], ['bananas', 1]], ['porridge', 'oatmeal', 'banana oats']),
    recipe('yogurt-fruit', 'Yogurt with fruit', 'breakfast', [['yogurt', 150], ['bananas', 1], ['apples', 1]], ['yogurt fruit', 'yoghurt fruit', 'fruit yogurt', 'fruit yoghurt']),
    recipe('cheese-toast', 'Cheese on toast', 'breakfast', [['bread', 2], ['cheese', 40]], ['cheese toast', 'cheese on toast', 'cheese sandwich']),
    recipe('avocado-toast', 'Avocado on toast', 'breakfast', [['bread', 2], ['avocado', 1]], ['avocado toast', 'avocado on toast']),
    recipe('pancakes', 'Simple pancakes', 'breakfast', [['flour', 75], ['milk', 100], ['eggs', 1], ['oliveOil', 3]], ['pancakes', 'pancake']),
    recipe('chicken-rice', 'Chicken and rice', 'dinner', [['chicken', 150], ['rice', 75], ['carrots', 80], ['oliveOil', 5]], ['chicken rice', 'rice chicken', 'chicken and rice']),
    recipe('vegetable-rice', 'Vegetable rice', 'lunch', [['rice', 75], ['courgette', 100], ['carrots', 80], ['oliveOil', 5]], ['vegetable rice', 'veggie rice', 'veg rice']),
    recipe('egg-fried-rice', 'Egg fried rice', 'lunch', [['rice', 75], ['eggs', 2], ['carrots', 80], ['oliveOil', 5]], ['egg fried rice', 'egg rice', 'fried rice']),
    recipe('fish-rice', 'Fish and rice', 'dinner', [['fish', 150], ['rice', 75], ['carrots', 80], ['oliveOil', 5]], ['fish rice', 'rice fish', 'fish and rice']),
    recipe('chicken-potatoes', 'Chicken and potatoes', 'dinner', [['chicken', 150], ['potatoes', 200], ['carrots', 80], ['oliveOil', 5]], ['chicken potatoes', 'chicken potato', 'chicken and potatoes', 'roast chicken']),
    recipe('omelette', 'Cheese omelette', 'lunch', [['eggs', 2], ['cheese', 30], ['freshTomatoes', 75], ['oliveOil', 5]], ['omelette', 'omelet']),
    recipe('baked-potato', 'Baked potato with cheese', 'lunch', [['potatoes', 250], ['cheese', 40]], ['baked potato', 'jacket potato', 'baked potatoes']),
    recipe('tomato-pizza', 'Tomato and cheese pizza', 'dinner', [['pizzaBase', 1], ['tinnedTomatoes', 100], ['cheese', 75]], ['pizza', 'margherita']),
    recipe('chicken-wrap', 'Chicken wraps', 'lunch', [['tortillas', 2], ['chicken', 150], ['cucumber', 80], ['yogurt', 30]], ['chicken wrap', 'chicken wraps']),
    recipe('tuna-sandwich', 'Tuna sandwiches', 'lunch', [['bread', 2], ['tuna', 80], ['cucumber', 60], ['mayonnaise', 15]], ['tuna sandwich', 'tuna sandwiches'])
  ];

  function fail(message) { throw new Error(message); }
  function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object.');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(label + ' must be a plain object.');
    if (!Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(label + ' must contain data fields.');
    return value;
  }
  function text(value, fallback, limit, label, required) {
    if (value === undefined) value = fallback;
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(label + ' must be text of at most ' + limit + ' characters.');
    value = value.trim();
    if (required && !value) fail(label + ' is required.');
    return value;
  }
  function number(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_AMOUNT) fail(label + ' must be a number greater than zero, up to ' + MAX_AMOUNT + '.');
    return value;
  }
  function peopleNumber(value) {
    if (!Number.isInteger(value) || value < 1 || value > 20) fail('Use a number of people from 1 to 20.');
    return value;
  }
  function epoch(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail('Invalid ' + label + '.');
    return value;
  }
  function list(value, limit, label) {
    if (!Array.isArray(value) || value.length > limit) fail(label + ' must be a list of at most ' + limit + ' items.');
    return value;
  }
  function ingredientId(value) {
    if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(INGREDIENTS, value)) fail('Unknown ingredient.');
    return value;
  }
  function store(value) {
    if (value === undefined) return '';
    if (!STORES.includes(value)) fail('Choose Kibsons, Waitrose, Carrefour, or no store.');
    return value;
  }
  function url(value) {
    const raw = text(value, '', 2048, 'Product link');
    if (!raw) return '';
    let parsed;
    try { parsed = new URL(raw); } catch (_) { fail('Use an HTTPS product link without embedded credentials.'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) fail('Use an HTTPS product link without embedded credentials.');
    return parsed.href;
  }
  function source(value) {
    if (value === undefined || value === '') return '';
    if (value !== SOURCE) fail('Product preferences must be saved by you in Tidy.');
    return SOURCE;
  }
  function preference(input) {
    record(input, 'Product preference');
    return {
      ingredientId: ingredientId(input.ingredientId),
      productName: text(input.productName, '', 160, 'Product name', true),
      store: store(input.store), url: url(input.url), source: source(input.source) || SOURCE
    };
  }
  function preferences(input) {
    const cleaned = list(input, 50, 'Product preferences').map(preference);
    const ids = cleaned.map(item => item.ingredientId);
    if (new Set(ids).size !== ids.length) fail('Only one saved product per ingredient is supported.');
    return cleaned;
  }
  function draftItem(input) {
    record(input, 'Grocery draft item');
    const id = ingredientId(input.ingredientId);
    const unit = text(input.unit, INGREDIENTS[id][1], 10, 'Ingredient unit', true);
    if (!UNITS.includes(unit)) fail('Use g, ml, pieces, or item for the amount.');
    const productName = text(input.productName, '', 160, 'Product name');
    const productSource = source(input.source);
    if (productSource && !productName) fail('A saved product name is required for its source.');
    if (input.included !== undefined && typeof input.included !== 'boolean') fail('Included must be true or false.');
    return {
      ingredientId: id, name: text(input.name, INGREDIENTS[id][0], 120, 'Ingredient name', true),
      amount: number(input.amount, 'Ingredient amount'), unit, productName,
      store: store(input.store), url: url(input.url), included: input.included === undefined ? true : input.included,
      source: productSource
    };
  }
  function validateDraft(input) {
    record(input, 'Menu grocery draft');
    const recipeId = text(input.recipeId, undefined, 80, 'Recipe ID', true);
    const selected = CATALOGUE.find(item => item.id === recipeId);
    if (!selected) fail('Unknown recipe.');
    const status = input.status === undefined ? 'draft' : input.status;
    if (!['draft', 'approved'].includes(status)) fail('Invalid menu draft status.');
    const items = list(input.items, 30, 'Grocery draft items').map(draftItem);
    if (!items.length) fail('The grocery draft needs at least one ingredient.');
    if (new Set(items.map(item => item.ingredientId)).size !== items.length) fail('Duplicate grocery draft ingredient.');
    const createdAt = epoch(input.createdAt, 'draft creation time');
    const approvedAt = input.approvedAt === undefined || input.approvedAt === null ? null : epoch(input.approvedAt, 'approval time');
    if (status === 'draft' && approvedAt !== null) fail('An editable draft cannot have an approval time.');
    if (status === 'approved' && (approvedAt === null || approvedAt < createdAt)) fail('An approved draft needs a valid approval time.');
    if (status === 'approved' && !items.some(item => item.included)) fail('Choose at least one ingredient before approval.');
    return {
      id: text(input.id, undefined, 120, 'Draft ID', true),
      request: text(input.request, undefined, 1000, 'Meal request', true), recipeId,
      name: text(input.name, selected.name, 120, 'Meal name', true), people: peopleNumber(input.people),
      items, status, createdAt, approvedAt
    };
  }
  function emptyState() { return { version: 1, people: 4, preferences: [], draft: null }; }
  function validateState(input) {
    record(input, 'Quick menu');
    if (input.version !== 1) fail('Unsupported quick menu version.');
    return {
      version: 1, people: peopleNumber(input.people === undefined ? 4 : input.people),
      preferences: preferences(input.preferences === undefined ? [] : input.preferences),
      draft: input.draft === null || input.draft === undefined ? null : validateDraft(input.draft)
    };
  }
  function normalized(value) {
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\btomatoes\b/g, 'tomato');
  }
  function compact(value) {
    return normalized(value).replace(/\b(?:i|we|would|like|want|to|eat|have|some|please|can|could|you|make|me|us|a|an|the|for|with|and|in|of|on|it|tonight|today|tomorrow|dinner|lunch|breakfast)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function recipeScore(item, request) {
    const phrase = compact(request);
    const words = new Set(phrase.split(' '));
    let score = 0;
    for (const keyword of item.keywords) {
      const key = compact(keyword);
      const tokens = key.split(' ');
      if (phrase === key) score = Math.max(score, 100 + tokens.length);
      else if (tokens.every(token => words.has(token))) score = Math.max(score, 60 + tokens.length);
      else {
        const overlap = tokens.filter(token => words.has(token)).length;
        score = Math.max(score, overlap * 10);
      }
    }
    return score;
  }
  function summary(item) { return { id: item.id, name: item.name, meal: item.meal }; }
  function recipes() { return CATALOGUE.map(summary); }
  function suggestRecipes(request) {
    request = typeof request === 'string' ? request.slice(0, 1000) : '';
    const scored = CATALOGUE.map((item, index) => ({ item, score: recipeScore(item, request), index })).sort((a, b) => b.score - a.score || a.index - b.index);
    if (!scored[0].score) return ['tomato-pasta', 'chicken-rice', 'scrambled-eggs-toast'].map(id => summary(CATALOGUE.find(item => item.id === id)));
    return scored.slice(0, 3).map(row => summary(row.item));
  }
  function restrictionProblem(request) {
    const words = normalized(request);
    if (/\b(?:allerg\w*|intoleran\w*|coeliac|celiac|gluten|dairy free|dairyfree|vegan|keto|low carb|nut free|nutfree)\b/.test(words)) return 'I cannot check allergies or special diets from product labels. Choose a simple dish and review every ingredient and product label first.';
    // Every built-in dish has no beans. Other exclusions need a checked recipe
    // instead of quietly ignoring a change to what the user asked to eat.
    const remaining = words.replace(/\b(?:no|without|avoid|excluding|exclude)\s+beans?\b(?!\s+(?:and|or)\b)/g, '').trim();
    const exclusions = remaining.match(/\b(?:no|without|avoid|excluding|exclude)\b.+$/);
    if (exclusions) {
      const remainder = exclusions[0].replace(/\b(?:no|without|avoid|excluding|exclude|beans?|please|thanks|thank|you|and|or)\b/g, '').trim();
      if (remainder) return 'I cannot safely apply that ingredient change yet. Choose another simple dish below, then review its ingredients.';
    }
    return '';
  }
  function explicitPeople(request) {
    const match = normalized(request).match(/\bfor\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+(?:people|persons?|servings?))?\b/);
    if (!match) return null;
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    return /^\d+$/.test(match[1]) ? Number(match[1]) : words.indexOf(match[1]);
  }
  function unsupportedWords(request, selected) {
    const allowed = new Set(selected.keywords.flatMap(keyword => compact(keyword).split(' ')));
    for (const [id] of selected.ingredients) for (const word of normalized(INGREDIENTS[id][0]).split(' ')) allowed.add(word);
    // These words describe this catalogue's serving/entry format, rather than
    // ingredients. Other additions remain visible as a choice to review.
    if (selected.ingredients.some(([id]) => id === 'pasta')) { allowed.add('spaghetti'); allowed.add('penne'); }
    if (selected.ingredients.some(([id]) => ['tinnedTomatoes', 'freshTomatoes'].includes(id))) allowed.add('tomatoes');
    const filler = /\b(?:simple|easy|recipe|meal|meals|dish|food|cook|cooking|prepare|prepared|thanks|thank|yes|ok|okay|fresh|people|persons?|servings?|one|two|three|four|five|six|seven|eight|nine|ten|no|without|avoid|exclude|excluding|beans?)\b/g;
    return compact(request).replace(filler, ' ').split(/\s+/).filter(word => word && !/^\d+$/.test(word) && !allowed.has(word));
  }
  function createDraft(request, options) {
    options = options || {};
    const raw = text(request, undefined, 1000, 'Meal request', true);
    const available = preferences(options.preferences === undefined ? [] : options.preferences);
    const requestedPeople = explicitPeople(raw);
    const people = peopleNumber(requestedPeople === null ? (options.people === undefined ? 4 : options.people) : requestedPeople);
    const now = epoch(options.now === undefined ? Date.now() : options.now, 'current time');
    const problem = restrictionProblem(raw);
    if (problem) return { ok: false, reason: problem, choices: suggestRecipes(raw) };
    const dishHeads = normalized(raw).replace(/\b(?:spaghetti|penne)\s+pasta\b/g, 'pasta');
    if (options.recipeId === undefined && (dishHeads.match(/\b(?:pasta|spaghetti|penne)\b/g) || []).length > 1) {
      return { ok: false, reason: 'Choose one dish for this grocery draft. I will fill in its ingredients for you.', choices: suggestRecipes(raw) };
    }
    let selected;
    if (options.recipeId !== undefined) {
      selected = CATALOGUE.find(item => item.id === options.recipeId);
      if (!selected) fail('Choose a known recipe.');
    } else {
      const ranked = CATALOGUE.map(item => ({ item, score: recipeScore(item, raw) })).sort((a, b) => b.score - a.score);
      // At least one complete, specific dish alias must match. A single broad
      // ingredient such as "chicken" offers choices rather than inventing a meal.
      if (ranked[0].score >= 60 && (!ranked[1] || ranked[0].score > ranked[1].score)) selected = ranked[0].item;
    }
    if (!selected) return { ok: false, reason: 'Choose the closest simple dish. I will fill in its ingredients for you.', choices: suggestRecipes(raw) };
    if (options.recipeId === undefined && unsupportedWords(raw, selected).length) return { ok: false, reason: 'I do not have a checked recipe for that exact combination. Choose a simple version below and I will fill in its ingredients.', choices: suggestRecipes(raw) };
    const words = normalized(raw);
    const shape = /\bspaghetti\b/.test(words) ? 'Spaghetti' : /\bpenne\b/.test(words) ? 'Penne' : '';
    const freshTomato = /\bfresh tomato(?:es)?\b/.test(words);
    const assumptions = [people + (people === 1 ? ' person' : ' people') + '. Amounts are a starting point; edit them before approving.'];
    const items = selected.ingredients.map(([originalId, perPerson]) => {
      const id = originalId === 'tinnedTomatoes' && freshTomato ? 'freshTomatoes' : originalId;
      const saved = available.find(item => item.ingredientId === id);
      let compatible = saved;
      if (id === 'pasta' && shape && saved && !new RegExp('\\b' + shape.toLowerCase() + '\\b').test(normalized(saved.productName))) {
        compatible = null;
        assumptions.push('You asked for ' + shape.toLowerCase() + ', so your saved pasta product was not substituted.');
      }
      return {
        ingredientId: id, name: id === 'pasta' && shape ? shape : INGREDIENTS[id][0],
        amount: Math.round(perPerson * people * 1000) / 1000, unit: INGREDIENTS[id][1],
        productName: compatible ? compatible.productName : '', store: compatible ? compatible.store : '',
        url: compatible ? compatible.url : '', included: true, source: compatible ? SOURCE : ''
      };
    });
    const draft = validateDraft({
      id: options.id === undefined ? 'menu-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 10) : options.id,
      request: raw, recipeId: selected.id, name: selected.name, people, items,
      status: 'draft', createdAt: now, approvedAt: null
    });
    return { ok: true, draft, assumptions };
  }
  function updateDraft(input, patch) {
    const draft = validateDraft(input);
    record(patch, 'Draft changes');
    const people = patch.people === undefined ? draft.people : peopleNumber(patch.people);
    let items = patch.items === undefined ? draft.items : list(patch.items, 30, 'Grocery draft items').map(item => {
      record(item, 'Grocery draft item');
      const previous = draft.items.find(prior => prior.ingredientId === item.ingredientId);
      // An edited suggestion is not a product the user has already saved.
      // Remembering it is a separate, explicit action in the interface.
      const productChanged = !previous || item.productName !== previous.productName || item.store !== previous.store || item.url !== previous.url;
      return productChanged ? { ...item, source: '' } : item;
    });
    if (patch.items === undefined && people !== draft.people) items = draft.items.map(item => ({ ...item, amount: Math.round(item.amount * people / draft.people * 1000) / 1000 }));
    return validateDraft({ ...draft, people, items, status: 'draft', approvedAt: null });
  }
  function approveDraft(input, options) {
    const draft = validateDraft(input);
    if (!draft.items.some(item => item.included)) fail('Choose at least one ingredient before approval.');
    options = options || {};
    return validateDraft({ ...draft, status: 'approved', approvedAt: epoch(options.now === undefined ? Date.now() : options.now, 'approval time') });
  }
  function rememberPreferences(input, draft) {
    const saved = preferences(input);
    const checked = validateDraft(draft);
    for (const item of checked.items) {
      if (!item.included || !item.productName) continue;
      const next = preference({ ingredientId: item.ingredientId, productName: item.productName, store: item.store, url: item.url, source: SOURCE });
      const index = saved.findIndex(existing => existing.ingredientId === item.ingredientId);
      if (index === -1) saved.push(next); else saved[index] = next;
    }
    return preferences(saved);
  }

  const api = Object.freeze({ emptyState, validateState, recipes, suggestRecipes, createDraft, updateDraft, approveDraft, rememberPreferences });
  root.TidyMenuHelper = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
