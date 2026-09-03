export function normalizeSearchText(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

export function topicMatchesSearch(topic, query) {
  const searchText = normalizeSearchText(query);
  return !searchText || normalizeSearchText(topic.textContent).includes(searchText);
}

export function initializeHelpSearch(documentRef = document) {
  const input = documentRef.querySelector('#helpSearch');
  const clear = documentRef.querySelector('#clearSearch');
  const status = documentRef.querySelector('#searchStatus');
  const noResults = documentRef.querySelector('#noResults');
  const topics = [...documentRef.querySelectorAll('.help-topic')];
  if (!input || !clear || !status || !noResults || topics.length === 0) return;

  const originalOpenState = new Map(topics.map(topic => [topic, topic.open]));
  const updateResults = () => {
    const query = normalizeSearchText(input.value);
    let matches = 0;
    for (const topic of topics) {
      const matched = topicMatchesSearch(topic, query);
      topic.hidden = !matched;
      if (matched) {
        matches += 1;
        topic.open = query ? true : originalOpenState.get(topic);
      }
    }
    clear.hidden = !query;
    noResults.hidden = matches !== 0;
    status.textContent = query
      ? `Showing ${matches} of ${topics.length} help topics for “${input.value.trim()}”.`
      : `Showing all ${topics.length} help topics.`;
  };

  input.addEventListener('input', updateResults);
  clear.addEventListener('click', () => {
    input.value = '';
    updateResults();
    input.focus();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.value) {
      input.value = '';
      updateResults();
    }
  });
  for (const link of documentRef.querySelectorAll('.topic-index a')) {
    link.addEventListener('click', () => {
      input.value = '';
      updateResults();
      const target = documentRef.getElementById(link.getAttribute('href').slice(1));
      if (target) target.open = true;
    });
  }
  updateResults();
}

if (typeof document !== 'undefined') initializeHelpSearch();
