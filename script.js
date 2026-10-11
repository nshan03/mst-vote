const optionButtons = [...document.querySelectorAll('.option')];
const submitButton = document.getElementById('submitVote');
const messageEl = document.getElementById('message');
const resultsEl = document.getElementById('results');
const totalVotesEl = document.getElementById('totalVotes');
const modeTextEl = document.getElementById('modeText');
const OPTIONS = ['A', 'B', 'C'];
const TABLE = 'mst_votes';
const DEMO_KEY = 'mst_demo_vote';
const selected = new Set();
let locked = false;
let busy = true;
let sb = null;
const hasSupabaseConfig = typeof SUPABASE_URL === 'string' && typeof SUPABASE_ANON_KEY === 'string' && !SUPABASE_URL.includes('YOUR_') && !SUPABASE_ANON_KEY.includes('YOUR_');

function getDeviceId() {
  let id = localStorage.getItem('mst_vote_device_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('mst_vote_device_id', id);
  }
  return id;
}
const deviceId = getDeviceId();
function parseChoice(choice) {
  return typeof choice === 'string' ? OPTIONS.filter(key => choice.split(',').includes(key)) : [];
}
function updateControls() {
  optionButtons.forEach(btn => {
    const active = selected.has(btn.dataset.option);
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.disabled = locked || busy;
  });
  submitButton.disabled = locked || busy || selected.size === 0;
}
function setSubmitted(choice) {
  selected.clear();
  parseChoice(choice).forEach(key => selected.add(key));
  locked = true;
  submitButton.textContent = '已提交';
  updateControls();
}
function renderResults(rows) {
  const counts = { A: 0, B: 0, C: 0 };
  rows.forEach(row => parseChoice(row.choice).forEach(key => counts[key]++));
  const total = rows.length;
  totalVotesEl.textContent = `${total} 人参与`;
  OPTIONS.forEach(key => {
    const pct = total ? counts[key] / total * 100 : 0;
    document.getElementById(`bar-${key}`).style.width = `${pct}%`;
    document.getElementById(`value-${key}`).textContent = `${counts[key]} 人 · ${pct.toFixed(0)}%`;
  });
  resultsEl.classList.remove('hidden');
}
async function loadResults() {
  const rows = [];
  // Fetch every page so a class or event above the API row limit is still counted.
  for (let start = 0; ; start += 1000) {
    const { data, error } = await sb.from(TABLE).select('id,choice').order('id').range(start, start + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  renderResults(rows);
}
async function findMyVote() {
  const { data, error } = await sb.from(TABLE).select('choice').eq('device_id', deviceId).maybeSingle();
  if (error) throw error;
  return data?.choice || null;
}
async function refreshResults() {
  try { await loadResults(); }
  catch (error) {
    console.error(error);
    messageEl.textContent = locked ? '投票已保存，但结果读取失败，请刷新页面重试。' : '读取票数失败，请检查投票服务配置。';
  }
}
async function submitVote() {
  if (locked || busy || !selected.size) return;
  const choice = OPTIONS.filter(key => selected.has(key)).join(',');
  busy = true;
  updateControls();
  messageEl.textContent = '正在提交…';
  try {
    if (!sb) {
      localStorage.setItem(DEMO_KEY, choice);
      setSubmitted(choice);
      messageEl.textContent = `提交成功，你选择了 ${choice.replaceAll(',', '、')}。演示模式：结果保存在当前设备。`;
      renderResults([{ choice }]);
      return;
    }
    const existing = await findMyVote();
    if (existing) {
      setSubmitted(existing);
      messageEl.textContent = `你已经提交过：${existing.replaceAll(',', '、')}`;
    } else {
      const { error } = await sb.from(TABLE).insert({ choice, device_id: deviceId });
      if (error) {
        // A second tab may have submitted while this request was in flight.
        if (error.code !== '23505') throw error;
        const saved = await findMyVote();
        if (!saved) throw error;
        setSubmitted(saved);
        messageEl.textContent = `你已经提交过：${saved.replaceAll(',', '、')}`;
      } else {
        setSubmitted(choice);
        messageEl.textContent = `提交成功，你选择了 ${choice.replaceAll(',', '、')}`;
      }
    }
    await refreshResults();
  } catch (error) {
    console.error(error);
    messageEl.textContent = '提交失败，请稍后重试；当前选择已保留。';
  } finally {
    busy = false;
    updateControls();
  }
}
async function init() {
  optionButtons.forEach(btn => btn.addEventListener('click', () => {
    if (locked || busy) return;
    const key = btn.dataset.option;
    selected.has(key) ? selected.delete(key) : selected.add(key);
    updateControls();
    messageEl.textContent = selected.size ? `已选择 ${OPTIONS.filter(key => selected.has(key)).join('、')}，可继续选择或取消，然后提交。` : '请至少选择一个选项，再提交投票。';
  }));
  submitButton.addEventListener('click', submitVote);
  updateControls();
  if (!hasSupabaseConfig) {
    modeTextEl.textContent = '演示模式：配置 Supabase 后即可全班共享实时票数';
    const demoVote = localStorage.getItem(DEMO_KEY);
    if (parseChoice(demoVote).length) {
      setSubmitted(demoVote);
      messageEl.textContent = `这台设备已经选择过：${demoVote.replaceAll(',', '、')}`;
      renderResults([{ choice: demoVote }]);
    }
    busy = false;
    updateControls();
    return;
  }
  try {
    if (typeof supabase === 'undefined') throw new Error('Supabase SDK did not load');
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const myVote = await findMyVote();
    if (myVote) {
      setSubmitted(myVote);
      messageEl.textContent = `你已经提交过：${myVote.replaceAll(',', '、')}`;
    }
    await loadResults();
    sb.channel('mst-votes-live').on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, refreshResults).subscribe(status => {
      modeTextEl.textContent = status === 'SUBSCRIBED' ? '实时投票已连接' : '投票服务已连接，正在连接实时更新…';
    });
    busy = false;
    updateControls();
  } catch (error) {
    console.error(error);
    messageEl.textContent = '连接失败，请检查网络，并确认已执行最小生成树投票的数据库初始化 SQL，然后刷新页面。';
    modeTextEl.textContent = '投票服务未连接';
  }
}
init();
