// LINK OFICIAL DA SUA PLANILHA CONFIGURADO
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQc9Z1rDFqIOl_mbJZWIGlvfp6afWsQNiHTlAPKnuVhvJDMj1RpRXkU8r2Pt19x7PKvjfjc_4ssreiS/pub?gid=365665720&single=true&output=csv';

// Estado global da aplicação
const state = {
  raw: [],
  filtered: [],
  filters: {
    dateFrom: '',
    dateTo: '',
    tipos: new Set(),
    bairros: new Set(),
    regional: ''
  },
  meta: {
    tipos: [],
    bairros: [],
    regionais: []
  },
  log: {
    page: 0,
    perPage: 15,
    sortField: 'Data',
    sortAsc: false
  },
  granularity: 'day', // day, week, month
  monthBuckets: {} // fallback para dados embutidos se necessário
};

// Carregamento e Parsing da Planilha
async function bootstrap() {
  updateSyncStatus('loading', 'Baixando dados do Sheets...');
  try {
    Papa.parse(SHEET_URL, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: function(results) {
        if(results.errors && results.errors.length > 0) {
          console.warn("Avisos no parse:", results.errors);
        }
        if(!results.data || results.data.length === 0){
          throw new Error("Nenhum dado retornado da planilha.");
        }
        
        // Tratar dados obtidos
        processRawData(results.data);
        updateSyncStatus('ok', 'Sincronizado');
      },
      error: function(err) {
        console.error("Erro PapaParse:", err);
        updateSyncStatus('err', 'Erro na leitura do CSV');
      }
    });
  } catch(e) {
    console.error("Erro Bootstrap:", e);
    updateSyncStatus('err', 'Falha na conexão');
  }
}

function updateSyncStatus(status, text) {
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  if(!dot || !label) return;
  
  dot.className = 'dot ' + status;
  label.textContent = text;
}

function processRawData(data) {
  // Conversão e limpeza rápida dos registros
  state.raw = data.map(row => {
    return {
      ...row,
      // Garante campos padronizados para busca/filtros
      Data: row['Data'] || row['Data Ocorrência'] || '',
      Bairro: (row['Bairro'] || '').trim().toUpperCase(),
      Tipo: (row['Tipo Final'] || row['Natureza Final'] || '').trim(),
      Regional: (row['Regional'] || '').trim()
    };
  });
  
  document.getElementById('totalPill').textContent = `${state.raw.length} registros`;
  
  // Extrair metadados para os filtros multimarcagem
  extractMeta();
  initFilterElements();
  
  // Resetar e aplicar filtros iniciais
  resetFilters();
}

function extractMeta() {
  const tSet = new Set(), bSet = new Set(), rSet = new Set();
  state.raw.forEach(r => {
    if(r.Tipo) tSet.add(r.Tipo);
    if(r.Bairro) bSet.add(r.Bairro);
    if(r.Regional) rSet.add(r.Regional);
  });
  
  state.meta.tipos = Array.from(tSet).sort();
  state.meta.bairros = Array.from(bSet).sort();
  state.meta.regionais = Array.from(rSet).sort();
}

function initFilterElements() {
  // Preencher select nativo de regionais
  const rSel = document.getElementById('regionalSelect');
  if(rSel) {
    rSel.innerHTML = '<option value="">Regional: todas</option>';
    state.meta.regionais.forEach(r => {
      if(!r) return;
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = `Regional: ${r}`;
      rSel.appendChild(opt);
    });
  }
  
  // Os dropdowns customizados de Tipo e Bairro serão povoados dinamicamente ao abrir
  renderMultiselectList('tipo');
  renderMultiselectList('bairro');
}

function renderMultiselectList(type) {
  const listEl = document.getElementById(`${type}List`);
  if(!listEl) return;
  
  const items = type === 'tipo' ? state.meta.tipos : state.meta.bairros;
  const selectedSet = type === 'tipo' ? state.filters.tipos : state.filters.bairros;
  
  listEl.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'msel-item';
    
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = selectedSet.has(item);
    chk.addEventListener('change', () => {
      if(chk.checked) selectedSet.add(item);
      else selectedSet.delete(item);
      applyFilters();
    });
    
    const span = document.createElement('span');
    span.textContent = item;
    
    div.appendChild(chk);
    div.appendChild(span);
    listEl.appendChild(div);
  });
  
  updateMultiselectCount(type);
}

function updateMultiselectCount(type) {
  const countEl = document.getElementById(`${type}Count`);
  if(!countEl) return;
  
  const selectedSet = type === 'tipo' ? state.filters.tipos : state.filters.bairros;
  const totalCount = type === 'tipo' ? state.meta.tipos.length : state.meta.bairros.length;
  
  if(selectedSet.size === 0 || selectedSet.size === totalCount) {
    countEl.textContent = 'todos';
  } else {
    countEl.textContent = selectedSet.size;
  }
}

function resetFilters() {
  state.filters.dateFrom = '';
  state.filters.dateTo = '';
  state.filters.tipos = new Set(state.meta.tipos);
  state.filters.bairros = new Set(state.meta.bairros);
  state.filters.regional = '';
  
  // Sincronizar elementos visuais
  if(document.getElementById('dateFrom')) document.getElementById('dateFrom').value = '';
  if(document.getElementById('dateTo')) document.getElementById('dateTo').value = '';
  if(document.getElementById('regionalSelect')) document.getElementById('regionalSelect').value = '';
  
  renderMultiselectList('tipo');
  renderMultiselectList('bairro');
  
  applyFilters();
}

function applyFilters() {
  state.filtered = state.raw.filter(r => {
    if(state.filters.dateFrom && r.Data < state.filters.dateFrom) return false;
    if(state.filters.dateTo && r.Data > state.filters.dateTo) return false;
    if(state.filters.regional && r.Regional !== state.filters.regional) return false;
    if(r.Tipo && !state.filters.tipos.has(r.Tipo)) return false;
    if(r.Bairro && !state.filters.bairros.has(r.Bairro)) return false;
    return true;
  });
  
  updateMultiselectCount('tipo');
  updateMultiselectCount('bairro');
  
  rebuildAll();
}

function rebuildAll() {
  console.log("Reconstruindo painel com registros:", state.filtered.length);
  // Atualiza KPIs primários
  calculateKPIs();
  // Atualiza tabelas e gráficos se existirem no escopo global do index
  if(window.renderLogTable) renderLogTable();
  if(window.updateCharts) updateCharts();
}

function calculateKPIs() {
  const total = state.filtered.length;
  document.getElementById('kpiTotal').textContent = total || '0';
  
  if(total === 0) {
    document.getElementById('kpiAvg').textContent = '—';
    document.getElementById('kpiPeakHour').textContent = '—';
    document.getElementById('kpiTopBairro').textContent = '—';
    document.getElementById('kpiTopTipo').textContent = '—';
    return;
  }
  
  // Exemplo básico de contagem para o bairro e tipo mais frequente
  const bairrosCount = {}, tiposCount = {};
  state.filtered.forEach(r => {
    if(r.Bairro) bairrosCount[r.Bairro] = (bairrosCount[r.Bairro] || 0) + 1;
    if(r.Tipo) tiposCount[r.Tipo] = (tiposCount[r.Tipo] || 0) + 1;
  });
  
  let topBairro = '—', maxB = 0;
  for(const b in bairrosCount) {
    if(bairrosCount[b] > maxB) { maxB = bairrosCount[b]; topBairro = b; }
  }
  
  let topTipo = '—', maxT = 0;
  for(const t in tiposCount) {
    if(tiposCount[t] > maxT) { maxT = tiposCount[t]; topTipo = t; }
  }
  
  document.getElementById('kpiTopBairro').textContent = topBairro;
  document.getElementById('kpiTopTipo').textContent = topTipo;
}

// Configuração de eventos globais
function wireEvents() {
  // Sincronizar botão atualizar
  const btnSync = document.getElementById('btnSync');
  if(btnSync) btnSync.addEventListener('click', () => bootstrap());
  
  // Limpar filtros
  const btnClear = document.getElementById('btnClearFilters');
  if(btnClear) btnClear.addEventListener('click', () => resetFilters());
  
  // Select regional
  const rSel = document.getElementById('regionalSelect');
  if(rSel) rSel.addEventListener('change', (e) => {
    state.filters.regional = e.target.value;
    applyFilters();
  });
  
  // Datas
  const dFrom = document.getElementById('dateFrom');
  const dTo = document.getElementById('dateTo');
  if(dFrom) dFrom.addEventListener('change', (e) => { state.filters.dateFrom = e.target.value; applyFilters(); });
  if(dTo) dTo.addEventListener('change', (e) => { state.filters.dateTo = e.target.value; applyFilters(); });

  // Evento simples para abrir/fechar dropdowns customizados
  document.querySelectorAll('.msel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const parent = btn.parentElement;
      const isOpen = parent.classList.contains('open');
      document.querySelectorAll('.msel').forEach(el => el.classList.remove('open'));
      if(!isOpen) parent.classList.add('open');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.msel').forEach(el => el.classList.remove('open'));
  });
  
  const panels = document.querySelectorAll('.msel-panel');
  panels.forEach(p => p.addEventListener('click', (e) => e.stopPropagation()));
}

// Inicialização automatizada ao carregar a página
async function init() {
  if(window.Chart) {
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = '#a9b8c4';
  }

  wireEvents();
  await bootstrap();
  
  const footerInfo = document.getElementById('footerInfo');
  if(footerInfo) {
    footerInfo.textContent = 'Painel de Ocorrências · dados sincronizados via Google Sheets';
  }
}

if(document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}