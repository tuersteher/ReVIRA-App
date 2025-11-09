  // ---- Config: modality mapping (adjust codes to your dataset if needed) ----
  // Keep this table in one place so you can tweak it easily later.
  const MODALITY = {
    TRAIN:   new Set([100]), // classic rail services
    HEV:     new Set([109]),         // HÉV / suburban rail
    BUS:     new Set([200]), // bus / coach / other
  };

  // Simple helpers for classification
  function hasAny(codeSet, mArr) {
    if (!Array.isArray(mArr) || !mArr.length) return false;
    for (const v of mArr) if (codeSet.has(v)) return true;
    return false;
  }
  function isTrain(doc)   { return hasAny(MODALITY.TRAIN, doc.m); }
  function isHev(doc)     { return hasAny(MODALITY.HEV, doc.m); }
  function isBus(doc)     { return hasAny(MODALITY.BUS, doc.m); }

  // Priority: 0 = best (108_1 train), then train, then HÉV, then bus/other.
  function categoryPriority(doc) {
    if (doc.i108 && isTrain(doc)) return 0;
    if (isTrain(doc))             return 1;
    if (isHev(doc))               return 2;
    return 3; // bus/other/unknown
  }

  // Normalizer shared by index + queries
  function normalize(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // MiniSearch index (global in this scope)
  let mini = null;
  let stations = [];

  // Load data + build index once
  async function initStations() {
    // load the slim file (use .min.json if you serve it)
    stations = await fetch('/stations-slim.json').then(r => r.json());

    mini = new window.MiniSearch({
      idField: 'c',
      fields: ['n','a'],                 // canonical name + aliases
      storeFields: ['c','n','a','i108','hu','iso','m','nn'],
      processTerm: term => normalize(term),
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,                      // ~1 edit for short queries
        boost: { n: 2 }                  // prefer canonical over alias hits
      }
    });

    mini.addAll(stations);
  }

  // Compose ranking score (MiniSearch score + your business boosts)
  function scoreDoc(doc, queryRaw) {
    const q = normalize(queryRaw);
    let score = doc.score || 0;

    // Code boosts
    if (doc.c === queryRaw)        score += 60;
    else if (doc.c.startsWith(queryRaw)) score += 28;

    // Name boosts via normalized comparison
    const nn = doc.nn || normalize(doc.n);
    if (nn === q)           score += 35;
    else if (nn.startsWith(q)) score += 18;
    else if (nn.includes(q))   score += 6;

    // Business boosts
    if (doc.i108 && isTrain(doc)) score += 15;  // extra push for 108_1 trains
    if (isTrain(doc))             score += 10;
    else if (isHev(doc))          score += 4;
    // bus/other: no extra

    if (doc.hu)                   score += 6;   // prefer HU stations slightly

    return score;
  }

  // Your displayResults (fixed small typos, uses derived products flags)
  function displayResults(data) {
    const resultsContainer = document.getElementById('results');
    resultsContainer.innerHTML = '';

    data.forEach(entry => {
      const isSuburban = entry.products?.suburban;
      const isTrain    = entry.products?.train;
      const isBus      = entry.products?.bus;

      if (isTrain || isSuburban || isBus) {
        const suggestionDiv = document.createElement('div');
        suggestionDiv.classList.add('suggestion');

        const nameSpan = document.createElement('span');
        nameSpan.textContent = entry.name;

        const link = document.createElement('a');
        link.href = `departure.html?station=${entry.id}`;

        if (isSuburban) {
          const img = document.createElement('img');
          img.src = '../assets/icons/suburban.svg';
          img.alt = 'Suburban Icon';
          img.classList.add('bigicon','inverted');
          link.appendChild(img);
        }
        if (isTrain) {
          const img = document.createElement('img');
          img.src = '../assets/icons/rail.svg';
          img.alt = 'Rail Icon';
          img.classList.add('bigicon','inverted');
          link.appendChild(img);
        }
        if (isBus) {
          const img = document.createElement('img');
          img.src = '../assets/icons/bus.svg';
          img.alt = 'Bus Icon';
          img.classList.add('bigicon','inverted');
          link.appendChild(img);
        }

        suggestionDiv.appendChild(nameSpan);
        suggestionDiv.appendChild(link);

        suggestionDiv.addEventListener('click', () => {
          window.location.href = link.href;
        });

        resultsContainer.appendChild(suggestionDiv);
      }
    });
  }

  // Transform MiniSearch docs → your display shape
  function toDisplayEntry(doc) {
    return {
      id: doc.c,
      name: doc.n,
      // convert modalities to your product flags
      products: {
        train:    isTrain(doc),
        suburban: isHev(doc),
        bus:      isBus(doc)
      }
    };
  }

  // Debounce helper
  function debounce(fn, ms = 150) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---- Your oninput handler wiring ----
  window.searchLocations = debounce(async function searchLocations() {
    const el = document.getElementById('searchInput');
    const userInput = (el?.value || '').trim();
    if (!userInput) { displayResults([]); return; }

    // lazy init if needed
    if (!mini) await initStations();

    // search
    const hits = mini.search(userInput, { prefix: true, fuzzy: 0.2, boost: { n: 2 } });

    // enrich with priority + composite score
    const ranked = hits.map(h => {
      const prio = categoryPriority(h);
      const composite = scoreDoc(h, userInput);
      return { doc: h, prio, composite };
    });

    // sort by: category (prio ASC), then composite score (DESC), then name ASC
    ranked.sort((a, b) => {
      if (a.prio !== b.prio) return a.prio - b.prio;
      if (a.composite !== b.composite) return b.composite - a.composite;
      return a.doc.n.localeCompare(b.doc.n, 'hu');
    });

    // cap results (tweak as you like)
    const top = ranked.slice(0, 20).map(x => toDisplayEntry(x.doc));

    displayResults(top);
  }, 150);
