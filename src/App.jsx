import { useState, useEffect, useRef, useCallback } from "react";

// ─── STORAGE ────────────────────────────────────────────────
const DB = {
  async get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  async set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
};

// ─── URL UTILS ──────────────────────────────────────────────
function normalizeVideoUrl(url) {
  if (!url) return url;
  const gd = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (gd) return `https://drive.google.com/uc?export=download&id=${gd[1]}`;
  const go = url.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/);
  if (go) return `https://drive.google.com/uc?export=download&id=${go[1]}`;
  if (url.includes("dropbox.com")) return url.replace("dl=0", "dl=1");
  return url;
}
function detectUrlType(url) {
  if (!url) return null;
  if (url.includes("drive.google.com")) return "googledrive";
  if (url.includes("dropbox.com")) return "dropbox";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.match(/\.(mp4|mov|avi|webm)(\?|$)/i)) return "direct";
  return "unknown";
}
function fmtSize(b) { return b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`; }

// ─── CLAUDE API ─────────────────────────────────────────────
async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const d = await res.json();
  return d.content?.[0]?.text || "";
}

// ─── HEYGEN API ─────────────────────────────────────────────
async function hg(endpoint, key, method = "GET", body) {
  const res = await fetch(`https://api.heygen.com${endpoint}`, {
    method,
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
async function getAvatars(key) { const d = await hg("/v2/avatars?limit=100", key); return d?.data?.avatars || []; }
async function getVoices(key) {
  const d = await hg("/v2/voices?limit=100", key);
  const all = d?.data?.voices || [];
  const jp = all.filter(v => v.language === "Japanese" || v.locale?.startsWith("ja"));
  return jp.length > 0 ? jp : all.slice(0, 50);
}
async function makeVideo({ key, avatarId, voiceId, script, bgColor }) {
  return hg("/v2/video/generate", key, "POST", {
    video_inputs: [{ character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" }, voice: { type: "text", input_text: script, voice_id: voiceId }, background: { type: "color", value: bgColor || "#f0f4ff" } }],
    dimension: { width: 1280, height: 720 }
  });
}
async function getVideoStatus(id, key) { return hg(`/v1/video_status.get?video_id=${id}`, key); }
async function uploadFile(file, key) {
  const init = await fetch("https://api.heygen.com/v1/video.upload", { method: "POST", headers: { "X-Api-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, type: "video" }) });
  const d = await init.json();
  const uploadUrl = d?.data?.upload_url;
  if (!uploadUrl) throw new Error("アップロードURLの取得に失敗しました");
  await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "video/mp4" }, body: file });
  return d?.data?.video_url;
}
async function convertVideo({ key, videoUrl, avatarId, voiceId }) {
  const res = await fetch("https://api.heygen.com/v2/video/translate", {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ video_url: videoUrl, output_language: "ja", avatar_id: avatarId, ...(voiceId ? { voice_id: voiceId } : {}), translate_audio_only: false })
  });
  return res.json();
}
async function getConvertStatus(id, key) { return hg(`/v2/video/translate/${id}`, key); }

// ─── CONSTANTS ──────────────────────────────────────────────
const BIZ = ["事業A（EC動画）", "事業B（キャラクター動画）", "事業C（採用動画）"];
const BG_OPTS = [{ label: "オフィス白", value: "#F8FAFC" }, { label: "ライトグレー", value: "#E2E8F0" }, { label: "ライトブルー", value: "#EFF6FF" }, { label: "ネイビー", value: "#0F172A" }, { label: "グリーン", value: "#F0FDF4" }];
const TABS = [{ id: "make", icon: "✏️", label: "台本→動画" }, { id: "convert", icon: "🔄", label: "動画→キャラ変換" }, { id: "presets", icon: "📁", label: "プリセット" }, { id: "history", icon: "📂", label: "履歴" }, { id: "settings", icon: "⚙️", label: "設定" }];

// ════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState("make");
  const [apiKey, setApiKey] = useState("");
  const [apiInput, setApiInput] = useState("");
  const [showApi, setShowApi] = useState(false);
  const [avatars, setAvatars] = useState([]);
  const [voices, setVoices] = useState([]);
  const [presets, setPresets] = useState([]);
  const [history, setHistory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [copyData, setCopyData] = useState(null);

  useEffect(() => {
    (async () => {
      const k = await DB.get("apiKey"); if (k) { setApiKey(k); setApiInput(k); }
      const p = await DB.get("presets"); if (p) setPresets(p);
      const h = await DB.get("history"); if (h) setHistory(h);
      setLoaded(true);
    })();
  }, []);

  const saveKey = async () => { setApiKey(apiInput); await DB.set("apiKey", apiInput); setShowApi(false); };
  const savePresets = useCallback(async (d) => { setPresets(d); await DB.set("presets", d); }, []);
  const addHistory = useCallback(async (item) => {
    const u = [item, ...history].slice(0, 30); setHistory(u); await DB.set("history", u);
  }, [history]);
  const loadAssets = async () => {
    if (!apiKey) { setTab("settings"); return false; }
    try { const [a, v] = await Promise.all([getAvatars(apiKey), getVoices(apiKey)]); setAvatars(a); setVoices(v); return true; }
    catch { return false; }
  };

  const handleCopyFromHistory = (item, keepScript) => {
    setCopyData({ ...item, keepScript });
    setTab("make");
  };

  if (!loaded) return <Splash />;

  return (
    <div style={{ minHeight: "100vh", background: "#060D1F", fontFamily: "'Noto Sans JP','Segoe UI',sans-serif", color: "#E2E8F0" }}>
      <header style={{ background: "#0A1628", borderBottom: "1px solid #141F38", padding: "0 24px", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1060, margin: "0 auto", height: 54, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg,#4F8EF7,#7C5CFC)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17 }}>🎬</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#F1F5F9" }}>AI動画制作ツール</div>
              <div style={{ fontSize: 10, color: "#334155" }}>coolworks株式会社 スタッフ専用</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ display: "flex", background: "#060D1F", borderRadius: 8, padding: 3, gap: 2, border: "1px solid #141F38" }}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "5px 13px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600, background: tab === t.id ? "linear-gradient(135deg,#4F8EF7,#7C5CFC)" : "transparent", color: tab === t.id ? "#FFF" : "#475569" }}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
            <div onClick={() => setTab("settings")} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 11px", borderRadius: 16, background: apiKey ? "#0F2A1A" : "#2A0F0F", cursor: "pointer", border: `1px solid ${apiKey ? "#10B98130" : "#EF444430"}` }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: apiKey ? "#10B981" : "#EF4444" }} />
              <span style={{ fontSize: 11, color: apiKey ? "#10B981" : "#EF4444", fontWeight: 600 }}>{apiKey ? "HeyGen接続済" : "設定が必要"}</span>
            </div>
          </div>
        </div>
      </header>



      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "22px 20px" }}>
        {tab === "make" && <MakeTab apiKey={apiKey} avatars={avatars} voices={voices} presets={presets} onLoadAssets={loadAssets} onAddHistory={addHistory} onSavePreset={savePresets} copyData={copyData} onCopyUsed={() => setCopyData(null)} />}
        {tab === "convert" && <ConvertTab apiKey={apiKey} avatars={avatars} voices={voices} onLoadAssets={loadAssets} onAddHistory={addHistory} />}
        {tab === "presets" && <PresetsTab presets={presets} onSave={savePresets} avatars={avatars} voices={voices} onLoadAssets={loadAssets} />}
        {tab === "history" && <HistoryTab history={history} onCopy={handleCopyFromHistory} />}
        {tab === "settings" && <SettingsTab apiKey={apiKey} onSave={saveKey} apiInput={apiInput} setApiInput={setApiInput} history={history} presets={presets} />}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;600;700;800&display=swap');
        @keyframes pulse{0%,100%{opacity:.3}50%{opacity:.8}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#060D1F}::-webkit-scrollbar-thumb{background:#1E3A5F;border-radius:2px}
      `}</style>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: 台本→動画
// ════════════════════════════════════════════════════════════
function MakeTab({ apiKey, avatars, voices, presets, onLoadAssets, onAddHistory, onSavePreset, copyData, onCopyUsed }) {
  const [step, setStep] = useState(0);
  const [preset, setPreset] = useState(null);
  const [locked, setLocked] = useState(false);
  const [form, setForm] = useState({ product: "", bizType: "事業A（EC動画）", target: "", problem: "", features: "", cta: "" });
  const [script, setScript] = useState("");
  const [sLoading, setSLoading] = useState(false);
  const [aSearch, setASearch] = useState("");
  const [vSearch, setVSearch] = useState("");
  const [selAv, setSelAv] = useState(null);
  const [selVo, setSelVo] = useState(null);
  const [bg, setBg] = useState("#F8FAFC");
  const [aLoading, setALoading] = useState(false);
  const [videoId, setVideoId] = useState(null);
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState(null);
  const [err, setErr] = useState("");
  const poll = useRef(null);

  // 履歴からコピーされたデータを適用
  useEffect(() => {
    if (!copyData) return;
    setStep(0);
    setForm(f => ({ ...f, bizType: copyData.bizType || f.bizType }));
    if (copyData.keepScript && copyData.script) setScript(copyData.script);
    else setScript("");
    // アバター・音声はassets読み込み後に適用するため一時保存
    onCopyUsed();
  }, [copyData]);

  const applyPreset = (p) => {
    setPreset(p); setLocked(true);
    if (p.bgColor) setBg(p.bgColor);
    if (p.bizType) setForm(f => ({ ...f, bizType: p.bizType }));
  };

  const genScript = async () => {
    if (!form.product) return;
    setSLoading(true);
    try {
      const tmpl = preset?.scriptTemplate ? `テンプレート参考：\n${preset.scriptTemplate}\n\n` : "";
      setScript(await callClaude(`${tmpl}AI動画台本専門家として以下の情報をもとに60秒以内の動画台本を作成してください。\n商品:${form.product}\n事業:${form.bizType}\nターゲット:${form.target||"中小企業経営者"}\n悩み:${form.problem||"動画制作に困っている"}\n特徴:${form.features||"顔出し不要・AI活用・量産可能"}\nCTA:${form.cta||"お気軽にお問い合わせください"}\n条件:1文20字以内・ですます調・句読点丁寧・数字に読み仮名・台本本文のみ出力`));
    } catch { setScript("生成に失敗しました。再試行してください。"); }
    setSLoading(false);
  };

  const goSettings = async () => {
    setALoading(true);
    const ok = await onLoadAssets();
    setALoading(false);
    if (ok) {
      setStep(1);
      if (preset) {
        const av = avatars.find(a => a.avatar_id === preset.avatarId);
        const vo = voices.find(v => v.voice_id === preset.voiceId);
        if (av) setSelAv(av);
        if (vo) setSelVo(vo);
      }
    }
  };

  const generate = async () => {
    if ((!selAv && !preset?.avatarId) || !script || !apiKey) return;
    const avId = selAv?.avatar_id || preset?.avatarId;
    const voId = selVo?.voice_id || preset?.voiceId;
    setStep(2); setErr(""); setProgress(10); setResultUrl(null);
    try {
      const res = await makeVideo({ key: apiKey, avatarId: avId, voiceId: voId, script, bgColor: bg });
      const id = res?.data?.video_id;
      if (id) { setVideoId(id); startPoll(id); }
      else { setErr(res?.message || "動画生成の開始に失敗しました。"); setStep(1); }
    } catch { setErr("APIエラーが発生しました。"); setStep(1); }
  };

  const startPoll = (id) => {
    let p = 15;
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      p = Math.min(p + 5, 92); setProgress(p);
      try {
        const res = await getVideoStatus(id, apiKey);
        const s = res?.data?.status;
        if (s === "completed") {
          clearInterval(poll.current); setProgress(100);
          const url = res?.data?.video_url; setResultUrl(url); setStep(3);
          await onAddHistory({ id, url, product: form.product, bizType: form.bizType, presetName: preset?.name || "なし", avatarName: selAv?.avatar_name || preset?.avatarName, type: "make", createdAt: new Date().toLocaleString("ja-JP") });
        } else if (s === "failed") { clearInterval(poll.current); setErr("動画生成に失敗しました。"); setStep(1); }
      } catch {}
    }, 5000);
  };
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const saveAsPreset = async () => {
    if (!selAv || !selVo) return;
    const name = prompt("プリセット名を入力（例：○○社・EC向け）");
    if (!name) return;
    const np = { id: Date.now().toString(), name, bizType: form.bizType, avatarId: selAv.avatar_id, avatarName: selAv.avatar_name, avatarImg: selAv.preview_image_url || "", voiceId: selVo.voice_id, voiceName: selVo.display_name || selVo.name, bgColor: bg, scriptTemplate: script?.slice(0, 200) || "", createdAt: new Date().toLocaleDateString("ja-JP") };
    await onSavePreset([...presets, np]);
    alert(`プリセット「${name}」を保存しました`);
  };

  const reset = () => { setStep(0); setScript(""); setVideoId(null); setProgress(0); setResultUrl(null); setErr(""); setPreset(null); setLocked(false); setSelAv(null); setSelVo(null); setBg("#F8FAFC"); setForm({ product: "", bizType: "事業A（EC動画）", target: "", problem: "", features: "", cta: "" }); };

  const STEPS = ["台本作成", "設定確認", "生成中", "完了"];

  return (
    <div style={{ animation: "fadein .3s ease" }}>
      <PTitle icon="✏️" title="台本生成 → アバター動画" sub="商品情報を入力してAIが台本を生成し、そのままアバター動画を生成します" />
      <Stepper current={step} labels={STEPS} />

      {step === 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {presets.length > 0 && (
              <Panel title="📁 プリセットを選ぶ（設定が自動適用されます）" accent="#4F8EF7">
                {presets.map(p => (
                  <div key={p.id} onClick={() => preset?.id === p.id ? (setPreset(null), setLocked(false)) : applyPreset(p)}
                    style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 9px", borderRadius: 7, cursor: "pointer", marginBottom: 5, border: `1px solid ${preset?.id === p.id ? "#4F8EF7" : "#141F38"}`, background: preset?.id === p.id ? "#0A1E3A" : "#060D1F" }}>
                    {p.avatarImg ? <img src={p.avatarImg} style={{ width: 30, height: 30, borderRadius: 5, objectFit: "cover" }} alt="" /> : <div style={{ width: 30, height: 30, borderRadius: 5, background: "#141F38", display: "flex", alignItems: "center", justifyContent: "center" }}>🎭</div>}
                    <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 700, color: "#E2E8F0" }}>{p.name}</div><div style={{ fontSize: 10, color: "#475569" }}>{p.avatarName} · {p.voiceName}</div></div>
                    {preset?.id === p.id && <span style={{ fontSize: 12, color: "#4F8EF7" }}>🔒 適用中</span>}
                  </div>
                ))}
                {preset && <div style={{ fontSize: 11, color: "#4F8EF7", padding: "6px 8px", background: "#0A1E3A", borderRadius: 6, marginTop: 4 }}>🔒 設定ロック中：アバター・音声は「{preset.name}」の設定に固定されます</div>}
              </Panel>
            )}
            <Panel title="📝 商品・サービス情報">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <FL label="商品・サービス名" req /><TI value={form.product} onChange={v => setForm({ ...form, product: v })} placeholder="例：AI商品説明動画制作サービス" />
                <FL label="事業タイプ" /><TS value={form.bizType} onChange={v => setForm({ ...form, bizType: v })} opts={BIZ} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div><FL label="ターゲット" /><TI value={form.target} onChange={v => setForm({ ...form, target: v })} placeholder="EC事業者" /></div>
                  <div><FL label="解決する悩み" /><TI value={form.problem} onChange={v => setForm({ ...form, problem: v })} placeholder="動画制作が高い" /></div>
                </div>
                <FL label="特徴・強み" /><TI value={form.features} onChange={v => setForm({ ...form, features: v })} placeholder="顔出し不要・月額制・量産可能" />
                <FL label="CTA" /><TI value={form.cta} onChange={v => setForm({ ...form, cta: v })} placeholder="まずは無料相談からどうぞ" />
                <Btn onClick={genScript} loading={sLoading} disabled={!form.product} variant="primary" size="lg" style={{ marginTop: 4 }}>✨ AIで台本を生成する</Btn>
              </div>
            </Panel>
          </div>

          <Panel title="📄 台本">
            {preset?.scriptTemplate && <div style={{ marginBottom: 8, padding: "7px 9px", background: "#0A2014", borderRadius: 6, border: "1px solid #10B98130", fontSize: 11, color: "#10B981" }}>✅ 「{preset.name}」のテンプレートを適用中</div>}
            {sLoading && <SSkel />}
            {!sLoading && !script && <Empty icon="📄" msg="左のフォームを入力して台本を生成してください" />}
            {!sLoading && script && (
              <>
                <textarea value={script} onChange={e => setScript(e.target.value)} style={{ width: "100%", minHeight: 280, padding: 11, borderRadius: 8, border: "1px solid #141F38", background: "#030810", color: "#CBD5E1", fontSize: 13, lineHeight: 1.9, fontFamily: "inherit", resize: "vertical", outline: "none" }} />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
                  <CCount text={script} />
                  <Btn onClick={genScript} loading={sLoading} variant="ghost" size="sm">🔄 再生成</Btn>
                </div>
                <Btn onClick={goSettings} loading={aLoading} variant="primary" size="lg" style={{ width: "100%", marginTop: 10 }}>次へ：アバター・音声を確認する →</Btn>
              </>
            )}
          </Panel>
        </div>
      )}

      {step === 1 && (
        <div style={{ marginTop: 18, animation: "fadein .3s ease" }}>
          {err && <Err msg={err} />}
          {locked && preset && (
            <div style={{ marginBottom: 14, padding: "10px 14px", background: "#0A1E3A", border: "1px solid #4F8EF740", borderRadius: 9, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18 }}>🔒</span>
              <div><div style={{ fontSize: 13, fontWeight: 700, color: "#4F8EF7" }}>「{preset.name}」の設定でロック中</div><div style={{ fontSize: 11, color: "#475569" }}>アバター・音声・背景は固定されています</div></div>
              <button onClick={() => setLocked(false)} style={{ marginLeft: "auto", fontSize: 11, color: "#64748B", background: "none", border: "1px solid #1E3A5F", borderRadius: 5, padding: "3px 9px", cursor: "pointer" }}>解除</button>
            </div>
          )}
          {locked && preset ? (
            <Panel title="✅ 適用中の設定" accent="#10B981">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                {[["🎭 アバター", preset.avatarName, preset.avatarImg], ["🎙️ 音声", preset.voiceName, null], ["🎨 背景色", BG_OPTS.find(b => b.value === preset.bgColor)?.label || "カスタム", null]].map(([label, val, img]) => (
                  <div key={label} style={{ padding: "10px 12px", background: "#030810", borderRadius: 8, border: "1px solid #141F38" }}>
                    <div style={{ fontSize: 10, color: "#334155", marginBottom: 5 }}>{label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {img && <img src={img} style={{ width: 22, height: 22, borderRadius: 4, objectFit: "cover" }} alt="" />}
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#E2E8F0" }}>{val}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <Panel title="🎭 アバターを選ぶ" accent="#7C5CFC">
                <TI value={aSearch} onChange={setASearch} placeholder="名前で検索..." style={{ marginBottom: 8 }} />
                <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
                  {avatars.filter(a => a.avatar_name?.toLowerCase().includes(aSearch.toLowerCase())).map(a => (
                    <ARow key={a.avatar_id} a={a} sel={selAv?.avatar_id === a.avatar_id} onSel={() => setSelAv(a)} color="#7C5CFC" />
                  ))}
                </div>
              </Panel>
              <Panel title="🎙️ 音声を選ぶ（日本語）" accent="#4F8EF7">
                <TI value={vSearch} onChange={setVSearch} placeholder="名前で検索..." style={{ marginBottom: 8 }} />
                <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {voices.filter(v => (v.display_name || v.name || "").toLowerCase().includes(vSearch.toLowerCase())).map(v => (
                    <VRow key={v.voice_id} v={v} sel={selVo?.voice_id === v.voice_id} onSel={() => setSelVo(v)} color="#4F8EF7" />
                  ))}
                </div>
              </Panel>
            </div>
          )}
          {!locked && (
            <Panel title="🎨 背景色" style={{ marginTop: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {BG_OPTS.map(c => <BgChip key={c.value} opt={c} sel={bg === c.value} onSel={() => setBg(c.value)} />)}
              </div>
            </Panel>
          )}
          <Panel title="📄 台本（最終確認）" style={{ marginTop: 12 }}>
            <textarea value={script} onChange={e => setScript(e.target.value)} style={{ width: "100%", minHeight: 90, padding: 9, borderRadius: 7, border: "1px solid #141F38", background: "#030810", color: "#CBD5E1", fontSize: 12, lineHeight: 1.8, fontFamily: "inherit", resize: "vertical", outline: "none" }} />
          </Panel>
          <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
            <Btn onClick={() => setStep(0)} variant="ghost">← 台本に戻る</Btn>
            {!locked && selAv && selVo && <Btn onClick={saveAsPreset} variant="ghost">💾 プリセット保存</Btn>}
            <Btn onClick={generate} disabled={locked ? false : (!selAv || !selVo)} variant="primary" size="lg" style={{ flex: 1 }}>🚀 動画を生成する</Btn>
          </div>
        </div>
      )}

      {step === 2 && <GenProgress progress={progress} labels={["台本の送信", "アバターの設定", "動画のレンダリング中...", "品質チェック", "完了"]} jobId={videoId} />}

      {step === 3 && (
        <div style={{ marginTop: 20, animation: "fadein .3s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 14 }}><div style={{ fontSize: 38 }}>🎉</div><div style={{ fontSize: 17, fontWeight: 700, color: "#10B981", marginTop: 5 }}>動画が完成しました！</div></div>
          <Panel>
            {resultUrl ? <video src={resultUrl} controls style={{ width: "100%", borderRadius: 9, maxHeight: 360 }} /> : <div style={{ height: 200, background: "#030810", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", color: "#334155" }}>動画URLを取得中...</div>}
            <RecordBox items={[["プリセット", preset?.name || "なし"], ["商品", form.product], ["アバター", selAv?.avatar_name || preset?.avatarName], ["Video ID", videoId]]} />
            <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
              {resultUrl && <a href={resultUrl} download target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", padding: 11, borderRadius: 8, background: "linear-gradient(135deg,#10B981,#059669)", color: "#FFF", fontWeight: 700, fontSize: 13, textAlign: "center", textDecoration: "none" }}>⬇️ ダウンロード</a>}
              <Btn onClick={reset} variant="ghost" size="lg" style={{ flex: 1 }}>＋ 新しい動画を作る</Btn>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: 動画→キャラ変換
// ════════════════════════════════════════════════════════════
function ConvertTab({ apiKey, avatars, voices, onLoadAssets, onAddHistory }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState("url");
  const [videoUrl, setVideoUrl] = useState("");
  const [normUrl, setNormUrl] = useState("");
  const [urlType, setUrlType] = useState(null);
  const [file, setFile] = useState(null);
  const [uploadedUrl, setUploadedUrl] = useState(null);
  const [uploadProg, setUploadProg] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [aSearch, setASearch] = useState("");
  const [vSearch, setVSearch] = useState("");
  const [selAv, setSelAv] = useState(null);
  const [selVo, setSelVo] = useState(null);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState(null);
  const [resultUrl, setResultUrl] = useState(null);
  const [err, setErr] = useState("");
  const [aLoading, setALoading] = useState(false);
  const [isDrag, setIsDrag] = useState(false);
  const fileRef = useRef(null);
  const dropRef = useRef(null);
  const poll = useRef(null);

  useEffect(() => {
    if (videoUrl) { setNormUrl(normalizeVideoUrl(videoUrl)); setUrlType(detectUrlType(videoUrl)); }
    else { setNormUrl(""); setUrlType(null); }
  }, [videoUrl]);

  useEffect(() => {
    const el = dropRef.current; if (!el) return;
    const over = e => { e.preventDefault(); setIsDrag(true); };
    const leave = () => setIsDrag(false);
    const drop = e => { e.preventDefault(); setIsDrag(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); };
    el.addEventListener("dragover", over); el.addEventListener("dragleave", leave); el.addEventListener("drop", drop);
    return () => { el.removeEventListener("dragover", over); el.removeEventListener("dragleave", leave); el.removeEventListener("drop", drop); };
  }, []);

  const handleFile = (f) => {
    if (!f.type.startsWith("video/")) { setErr("動画ファイルを選択してください"); return; }
    if (f.size > 500 * 1024 * 1024) { setErr("ファイルサイズは500MB以下にしてください"); return; }
    setFile(f); setUploadDone(false); setUploadedUrl(null); setErr("");
  };

  const handleUpload = async () => {
    if (!file || !apiKey) { if (!apiKey) alert("APIキーを設定してください"); return; }
    setUploading(true); setUploadProg(0); setErr("");
    const t = setInterval(() => setUploadProg(p => Math.min(p + 7, 90)), 400);
    try { const u = await uploadFile(file, apiKey); clearInterval(t); setUploadProg(100); setUploadedUrl(u); setUploadDone(true); }
    catch (e) { clearInterval(t); setErr(e.message || "アップロードに失敗しました"); setUploadProg(0); }
    setUploading(false);
  };

  const canProceed = () => mode === "url" ? (!!normUrl && urlType !== "youtube") : (!!uploadDone && !!uploadedUrl);
  const activeUrl = () => mode === "file" ? uploadedUrl : normUrl;

  const goSettings = async () => {
    setALoading(true);
    const ok = await onLoadAssets();
    setALoading(false);
    if (ok) setStep(1);
  };

  const startConvert = async () => {
    if (!selAv || !activeUrl() || !apiKey) return;
    setStep(2); setErr(""); setProgress(10); setResultUrl(null);
    try {
      const res = await convertVideo({ key: apiKey, videoUrl: activeUrl(), avatarId: selAv.avatar_id, voiceId: selVo?.voice_id });
      const id = res?.data?.video_id || res?.data?.job_id;
      if (id) { setJobId(id); startPoll(id); }
      else { setErr(res?.message || "変換開始に失敗しました。Businessプランが必要です。"); setStep(1); }
    } catch { setErr("APIエラーが発生しました"); setStep(1); }
  };

  const startPoll = (id) => {
    let p = 15;
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      p = Math.min(p + 4, 92); setProgress(p);
      try {
        const res = await getConvertStatus(id, apiKey);
        const s = res?.data?.status;
        if (s === "completed" || s === "success") {
          clearInterval(poll.current); setProgress(100);
          const url = res?.data?.video_url || res?.data?.url; setResultUrl(url); setStep(3);
          await onAddHistory({ id, url, avatarName: selAv?.avatar_name, voiceName: selVo ? (selVo.display_name || selVo.name) : "元の音声を維持", source: mode === "file" ? file?.name : videoUrl, type: "convert", createdAt: new Date().toLocaleString("ja-JP") });
        } else if (s === "failed" || s === "error") { clearInterval(poll.current); setErr("変換に失敗しました。元動画の形式を確認してください。"); setStep(1); }
      } catch {}
    }, 6000);
  };
  useEffect(() => () => { if (poll.current) clearInterval(poll.current); }, []);

  const reset = () => { setStep(0); setVideoUrl(""); setFile(null); setUploadedUrl(null); setUploadDone(false); setUploadProg(0); setSelAv(null); setSelVo(null); setJobId(null); setProgress(0); setResultUrl(null); setErr(""); };

  const STEPS = ["元動画を準備", "キャラ・音声を選ぶ", "変換中", "完了"];

  return (
    <div style={{ animation: "fadein .3s ease" }}>
      <PTitle icon="🔄" title="動画 → キャラクター変換" sub="自分が話した元動画を別のキャラクターに変換してリップシンクします（HeyGen Businessプラン必要）" />
      <Stepper current={step} labels={STEPS} />

      {step === 0 && (
        <div style={{ marginTop: 18 }}>
          {err && <Err msg={err} onClose={() => setErr("")} />}
          <div style={{ display: "flex", gap: 4, marginBottom: 14, background: "#060D1F", borderRadius: 9, padding: 4, border: "1px solid #141F38", width: "fit-content" }}>
            {[["url", "🔗", "URLで入力"], ["file", "📁", "ファイルをアップロード"]].map(([m, icon, label]) => (
              <button key={m} onClick={() => { setMode(m); setErr(""); }} style={{ padding: "8px 20px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, background: mode === m ? "linear-gradient(135deg,#7C5CFC,#EC4899)" : "transparent", color: mode === m ? "#FFF" : "#475569" }}>
                {icon} {label}
              </button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {mode === "url" ? (
                <Panel title="🔗 動画URLを入力" accent="#7C5CFC">
                  <FL label="Google Drive / Dropbox / 直接URL" req />
                  <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://drive.google.com/file/d/xxxxx/view"
                    style={{ ...iSt, border: `1px solid ${urlType === "youtube" ? "#EF4444" : urlType ? "#10B981" : "#141F38"}` }} />
                  {urlType && (
                    <div style={{ marginTop: 8, padding: "7px 9px", borderRadius: 6, fontSize: 11, background: urlType === "youtube" ? "#2A1010" : "#0A1E12", border: `1px solid ${urlType === "youtube" ? "#EF444430" : "#10B98130"}` }}>
                      {urlType === "googledrive" && <><span style={{ color: "#10B981" }}>✅ Google Drive を検出しました</span><br /><span style={{ color: "#334155" }}>{normUrl?.slice(0, 55)}...</span></>}
                      {urlType === "dropbox" && <span style={{ color: "#10B981" }}>✅ Dropboxリンクを検出しました</span>}
                      {urlType === "direct" && <span style={{ color: "#10B981" }}>✅ 動画URLを検出しました</span>}
                      {urlType === "unknown" && <span style={{ color: "#F59E0B" }}>⚠️ URLの形式を確認できません</span>}
                      {urlType === "youtube" && <span style={{ color: "#EF4444" }}>❌ YouTubeは非対応です。Google DriveまたはDropboxをご利用ください</span>}
                    </div>
                  )}
                  <div style={{ marginTop: 10, padding: "9px 11px", background: "#030810", borderRadius: 7, border: "1px solid #0F1828", fontSize: 11, color: "#334155", lineHeight: 1.8 }}>
                    <b style={{ color: "#475569" }}>Google Drive の手順：</b><br />
                    ① ファイルを右クリック→「共有」→「リンクをコピー」<br />
                    ② アクセス権を「リンクを知っている全員」に変更<br />
                    ③ コピーしたURLをここに貼り付け
                  </div>
                </Panel>
              ) : (
                <Panel title="📁 動画ファイルをアップロード" accent="#EC4899">
                  <div ref={dropRef} onClick={() => !file && fileRef.current?.click()}
                    style={{ border: `2px dashed ${isDrag ? "#EC4899" : file ? "#10B981" : "#1E2A40"}`, borderRadius: 9, padding: "24px 14px", textAlign: "center", cursor: file ? "default" : "pointer", background: isDrag ? "#2A0F2044" : file ? "#0A2A1A" : "#030810", transition: "all .2s" }}>
                    <input ref={fileRef} type="file" accept="video/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                    {!file ? (
                      <><div style={{ fontSize: 28, marginBottom: 6 }}>{isDrag ? "⬇️" : "📹"}</div><div style={{ fontSize: 12, fontWeight: 700, color: "#64748B" }}>{isDrag ? "ドロップしてアップロード" : "クリックまたはドラッグ＆ドロップ"}</div><div style={{ fontSize: 10, color: "#334155", marginTop: 3 }}>MP4・MOV対応 / 最大500MB</div></>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ fontSize: 24 }}>🎬</div>
                        <div style={{ flex: 1, textAlign: "left" }}><div style={{ fontSize: 12, fontWeight: 700, color: "#F1F5F9" }}>{file.name}</div><div style={{ fontSize: 10, color: "#475569" }}>{fmtSize(file.size)}</div></div>
                        <button onClick={e => { e.stopPropagation(); setFile(null); setUploadDone(false); setUploadedUrl(null); setUploadProg(0); }} style={{ background: "none", border: "1px solid #5E1B1B33", borderRadius: 5, color: "#EF4444", cursor: "pointer", fontSize: 11, padding: "2px 7px" }}>✕</button>
                      </div>
                    )}
                  </div>
                  {file && !uploadDone && (
                    <div style={{ marginTop: 10 }}>
                      {uploading ? (
                        <><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748B", marginBottom: 5 }}><span>アップロード中...</span><span>{uploadProg}%</span></div><div style={{ background: "#0F1A30", borderRadius: 5, height: 7, overflow: "hidden" }}><div style={{ height: "100%", width: `${uploadProg}%`, background: "linear-gradient(90deg,#7C5CFC,#EC4899)", borderRadius: 5, transition: "width .4s" }} /></div></>
                      ) : <Btn onClick={handleUpload} variant="gradient" style={{ width: "100%", marginTop: 2 }}>⬆️ HeyGenにアップロードする</Btn>}
                    </div>
                  )}
                  {uploadDone && <div style={{ marginTop: 9, padding: "8px 11px", background: "#0A2A1A", borderRadius: 7, border: "1px solid #10B98130", display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}><span>✅</span><span style={{ color: "#10B981", fontWeight: 700 }}>アップロード完了</span><button onClick={() => { setFile(null); setUploadDone(false); setUploadedUrl(null); setUploadProg(0); }} style={{ marginLeft: "auto", background: "none", border: "1px solid #1E3A5F33", borderRadius: 5, color: "#64748B", cursor: "pointer", fontSize: 10, padding: "2px 7px" }}>変更</button></div>}
                </Panel>
              )}

              <Panel title="📐 推奨条件">
                {[["尺", "30〜120秒"], ["画質", "720p以上"], ["背景", "単色・無地"], ["話し方", "ゆっくり・明瞭"], ["画角", "胸上・正面"]].map(([k, v]) => (
                  <div key={k} style={{ display: "flex", gap: 10, padding: "5px 0", borderBottom: "1px solid #0A1020", fontSize: 11 }}>
                    <span style={{ color: "#7C5CFC", minWidth: 36, fontWeight: 700 }}>{k}</span>
                    <span style={{ color: "#334155" }}>{v}</span>
                  </div>
                ))}
              </Panel>
            </div>
            <div style={{ padding: "16px", background: "#080F20", border: "1px solid #141F38", borderRadius: 11 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#64748B", marginBottom: 10 }}>⚠️ このツールについて</div>
              <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.9 }}>
                動画→キャラ変換機能は <span style={{ color: "#F59E0B", fontWeight: 700 }}>HeyGen Businessプラン（$89/月）</span> 以上が必要です。<br /><br />
                Creatorプラン（$29/月）では使用できません。<br /><br />
                まずは「台本→動画」タブで動作確認を行い、売上が安定してからこちらの機能をご利用ください。<br /><br />
                <span style={{ color: "#94A3B8" }}>処理時間：動画の長さにより3〜10分</span>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
            <Btn onClick={goSettings} loading={aLoading} disabled={!canProceed()} variant="gradient" size="lg">次へ：キャラ・音声を選ぶ →</Btn>
          </div>
        </div>
      )}

      {step === 1 && (
        <div style={{ marginTop: 18, animation: "fadein .3s ease" }}>
          {err && <Err msg={err} onClose={() => setErr("")} />}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <Panel title="🎭 変換後のキャラクター" accent="#7C5CFC">
              <TI value={aSearch} onChange={setASearch} placeholder="名前で検索..." style={{ marginBottom: 8 }} />
              <div style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 5 }}>
                {avatars.filter(a => a.avatar_name?.toLowerCase().includes(aSearch.toLowerCase())).map(a => <ARow key={a.avatar_id} a={a} sel={selAv?.avatar_id === a.avatar_id} onSel={() => setSelAv(a)} color="#7C5CFC" />)}
              </div>
            </Panel>
            <Panel title="🎙️ 変換後の音声" accent="#EC4899">
              <TI value={vSearch} onChange={setVSearch} placeholder="名前で検索..." style={{ marginBottom: 8 }} />
              <div onClick={() => setSelVo(null)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 9px", borderRadius: 7, cursor: "pointer", marginBottom: 5, border: `1px solid ${selVo === null ? "#EC4899" : "#141F38"}`, background: selVo === null ? "#2A0F20" : "#030810" }}>
                <div style={{ width: 34, height: 34, borderRadius: 5, background: "#141F38", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🔇</div>
                <div><div style={{ fontSize: 12, fontWeight: 700, color: "#E2E8F0" }}>元の音声を維持</div><div style={{ fontSize: 10, color: "#334155" }}>音声変換をスキップ</div></div>
                {selVo === null && <span style={{ color: "#EC4899", marginLeft: "auto" }}>✓</span>}
              </div>
              <div style={{ maxHeight: 290, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {voices.filter(v => (v.display_name || v.name || "").toLowerCase().includes(vSearch.toLowerCase())).map(v => <VRow key={v.voice_id} v={v} sel={selVo?.voice_id === v.voice_id} onSel={() => setSelVo(v)} color="#EC4899" />)}
              </div>
            </Panel>
          </div>
          <Panel title="✅ 変換設定の確認">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
              {[["元動画", mode === "file" ? file?.name : videoUrl?.slice(0, 30) + "...", "📹"], ["変換キャラ", selAv?.avatar_name || "⚠️ 未選択", "🎭", selAv?.preview_image_url], ["変換音声", selVo ? (selVo.display_name || selVo.name) : "元の音声を維持", "🎙️"]].map(([label, val, icon, img]) => (
                <div key={label} style={{ padding: "9px 11px", background: "#030810", borderRadius: 7, border: `1px solid ${label === "変換キャラ" && !selAv ? "#EF444430" : "#141F38"}` }}>
                  <div style={{ fontSize: 10, color: "#334155", marginBottom: 5 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {img ? <img src={img} style={{ width: 20, height: 20, borderRadius: 4, objectFit: "cover" }} alt="" /> : <span style={{ fontSize: 14 }}>{icon}</span>}
                    <span style={{ fontSize: 11, fontWeight: 700, color: label === "変換キャラ" && !selAv ? "#EF4444" : "#E2E8F0" }}>{val}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <div style={{ display: "flex", gap: 9, marginTop: 12 }}>
            <Btn onClick={() => { setStep(0); setErr(""); }} variant="ghost">← 戻る</Btn>
            <Btn onClick={startConvert} disabled={!selAv} variant="gradient" size="lg" style={{ flex: 1 }}>🚀 変換・リップシンクを開始する</Btn>
          </div>
        </div>
      )}

      {step === 2 && <GenProgress progress={progress} labels={["元動画の解析", "顔・動作の検出", "キャラクター適用中...", "音声変換", "リップシンク生成", "最終レンダリング"]} jobId={jobId} />}

      {step === 3 && (
        <div style={{ marginTop: 20, animation: "fadein .3s ease" }}>
          <div style={{ textAlign: "center", marginBottom: 14 }}><div style={{ fontSize: 38 }}>🎉</div><div style={{ fontSize: 17, fontWeight: 700, color: "#10B981", marginTop: 5 }}>変換完了！</div></div>
          <Panel>
            <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 14 }}>
              <div>
                {resultUrl ? <video src={resultUrl} controls style={{ width: "100%", borderRadius: 9, maxHeight: 300 }} /> : <div style={{ height: 200, background: "#030810", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", color: "#334155" }}>取得中...</div>}
                <div style={{ display: "flex", gap: 9, marginTop: 10 }}>
                  {resultUrl && <a href={resultUrl} download target="_blank" rel="noreferrer" style={{ flex: 1, display: "block", padding: 10, borderRadius: 8, background: "linear-gradient(135deg,#7C5CFC,#EC4899)", color: "#FFF", fontWeight: 700, fontSize: 12, textAlign: "center", textDecoration: "none" }}>⬇️ ダウンロード</a>}
                  <Btn onClick={reset} variant="ghost" style={{ flex: 1 }}>＋ 別の動画を変換</Btn>
                </div>
              </div>
              <RecordBox items={[["入力方法", mode === "file" ? "ファイル" : "URL"], ["元動画", mode === "file" ? file?.name : videoUrl?.slice(0, 25) + "..."], ["変換キャラ", selAv?.avatar_name], ["変換音声", selVo ? (selVo.display_name || selVo.name) : "元の音声を維持"], ["Job ID", jobId]]} />
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: プリセット管理
// ════════════════════════════════════════════════════════════
function PresetsTab({ presets, onSave, avatars, voices, onLoadAssets }) {
  const [showForm, setShowForm] = useState(false);
  const [aLoading, setALoading] = useState(false);
  const [form, setForm] = useState({ name: "", bizType: "事業A（EC動画）", avatarId: "", voiceId: "", bgColor: "#F8FAFC", scriptTemplate: "" });

  const loadAndShow = async () => {
    setALoading(true); await onLoadAssets(); setALoading(false); setShowForm(true);
  };
  const submit = async () => {
    if (!form.name) return;
    const av = avatars.find(a => a.avatar_id === form.avatarId);
    const vo = voices.find(v => v.voice_id === form.voiceId);
    const np = { id: Date.now().toString(), name: form.name, bizType: form.bizType, avatarId: form.avatarId, avatarName: av?.avatar_name || "（未選択）", avatarImg: av?.preview_image_url || "", voiceId: form.voiceId, voiceName: vo?.display_name || vo?.name || "（未選択）", bgColor: form.bgColor, scriptTemplate: form.scriptTemplate, createdAt: new Date().toLocaleDateString("ja-JP") };
    await onSave([...presets, np]);
    setForm({ name: "", bizType: "事業A（EC動画）", avatarId: "", voiceId: "", bgColor: "#F8FAFC", scriptTemplate: "" }); setShowForm(false);
  };
  const del = async (id) => { if (!confirm("削除しますか？")) return; await onSave(presets.filter(p => p.id !== id)); };

  return (
    <div style={{ animation: "fadein .3s ease" }}>
      <PTitle icon="📁" title="プリセット管理" sub="クライアントごとのキャラクター設定を登録します。制作人材が毎回同じ設定で生成できるようになります。" />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <Btn onClick={loadAndShow} loading={aLoading} variant="primary">＋ 新規プリセット作成</Btn>
      </div>
      {showForm && (
        <Panel title="✨ 新規プリセット登録" accent="#4F8EF7" style={{ marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><FL label="プリセット名" req /><TI value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="例：○○株式会社・EC向け" /></div>
            <div><FL label="事業タイプ" /><TS value={form.bizType} onChange={v => setForm({ ...form, bizType: v })} opts={BIZ} /></div>
            <div><FL label="アバター" /><TS value={form.avatarId} onChange={v => setForm({ ...form, avatarId: v })} opts={["（選択してください）", ...avatars.map(a => a.avatar_name)]} vals={["", ...avatars.map(a => a.avatar_id)]} /></div>
            <div><FL label="音声（日本語）" /><TS value={form.voiceId} onChange={v => setForm({ ...form, voiceId: v })} opts={["（選択してください）", ...voices.map(v => v.display_name || v.name)]} vals={["", ...voices.map(v => v.voice_id)]} /></div>
          </div>
          <div style={{ marginTop: 10 }}><FL label="背景色" /><div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 4 }}>{BG_OPTS.map(c => <BgChip key={c.value} opt={c} sel={form.bgColor === c.value} onSel={() => setForm({ ...form, bgColor: c.value })} />)}</div></div>
          <div style={{ marginTop: 10 }}><FL label="台本テンプレート（任意）" /><textarea value={form.scriptTemplate} onChange={e => setForm({ ...form, scriptTemplate: e.target.value })} placeholder="このクライアント向けの台本パターン。AIが同じスタイルで生成します。" style={{ width: "100%", height: 70, padding: 9, borderRadius: 6, border: "1px solid #141F38", background: "#030810", color: "#CBD5E1", fontSize: 11, lineHeight: 1.7, fontFamily: "inherit", resize: "vertical", outline: "none" }} /></div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Btn onClick={submit} variant="primary">✅ 保存する</Btn>
            <Btn onClick={() => setShowForm(false)} variant="ghost">キャンセル</Btn>
          </div>
        </Panel>
      )}
      {presets.length === 0 ? <Empty icon="📁" msg="まだプリセットがありません。クライアントごとに作成しましょう。" /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))", gap: 12 }}>
          {presets.map(p => (
            <Panel key={p.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div><div style={{ fontWeight: 700, fontSize: 14, color: "#F1F5F9" }}>{p.name}</div><div style={{ fontSize: 11, color: "#334155", marginTop: 2 }}>{p.bizType} · {p.createdAt}</div></div>
                <button onClick={() => del(p.id)} style={{ background: "none", border: "1px solid #5E1B1B33", borderRadius: 5, color: "#EF4444", cursor: "pointer", fontSize: 12, padding: "2px 7px" }}>🗑️</button>
              </div>
              {[["🎭 アバター", p.avatarName, p.avatarImg], ["🎙️ 音声", p.voiceName, null], ["🎨 背景", BG_OPTS.find(b => b.value === p.bgColor)?.label || p.bgColor, null, p.bgColor]].map(([label, val, img, cb]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, marginBottom: 5 }}>
                  {img ? <img src={img} style={{ width: 18, height: 18, borderRadius: 3, objectFit: "cover" }} alt="" /> : cb ? <div style={{ width: 14, height: 14, borderRadius: 3, background: cb, border: "1px solid #ffffff22", flexShrink: 0 }} /> : <span style={{ width: 18, textAlign: "center" }}>{label.split(" ")[0]}</span>}
                  <span style={{ color: "#334155", minWidth: 30 }}>{label.split(" ")[1]}</span>
                  <span style={{ color: "#64748B" }}>{val}</span>
                </div>
              ))}
              {p.scriptTemplate && <div style={{ marginTop: 8, padding: "5px 7px", background: "#0A1628", borderRadius: 5, fontSize: 10, color: "#334155" }}>📄 台本テンプレートあり</div>}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// TAB: 履歴
// ════════════════════════════════════════════════════════════
function HistoryTab({ history, onCopy }) {
  const [confirmId, setConfirmId] = useState(null);
  const [keepScript, setKeepScript] = useState(false);

  const handleCopy = (h) => { onCopy(h, keepScript); setConfirmId(null); };

  return (
    <div style={{ animation: "fadein .3s ease" }}>
      <PTitle icon="📂" title="制作履歴" sub={`${history.length}件の制作記録。「この設定でコピー作成」で同じ設定をそのまま再利用できます。`} />
      {history.length === 0 ? <Empty icon="📂" msg="まだ制作履歴がありません" /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {history.map(h => (
            <div key={h.id} style={{ padding: "12px 14px", background: "#080F20", border: `1px solid ${confirmId === h.id ? "#4F8EF7" : "#141F38"}`, borderRadius: 10, transition: "all .2s" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 8, background: h.type === "make" ? "#0A1E3A" : "#1A0D28", color: h.type === "make" ? "#4F8EF7" : "#EC4899", fontWeight: 700, border: `1px solid ${h.type === "make" ? "#4F8EF730" : "#EC489930"}` }}>{h.type === "make" ? "✏️ 台本→動画" : "🔄 キャラ変換"}</span>
                    <span style={{ fontWeight: 700, fontSize: 13, color: "#F1F5F9" }}>{h.product || h.avatarName || "動画"}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#334155", marginTop: 3 }}>{h.bizType || h.source} · {h.createdAt}</div>
                </div>
                <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                  {h.presetName && h.presetName !== "なし" && <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 8, background: "#0A1E3A", color: "#4F8EF7", border: "1px solid #4F8EF730" }}>📁 {h.presetName}</span>}
                  {h.url && <a href={h.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, background: "#0A2A14", color: "#10B981", textDecoration: "none", border: "1px solid #10B98130" }}>▶ 再生</a>}
                  {h.type === "make" && (
                    <button onClick={() => setConfirmId(confirmId === h.id ? null : h.id)}
                      style={{ fontSize: 12, padding: "4px 12px", borderRadius: 6, background: confirmId === h.id ? "#0A1E3A" : "#0D1F3A", color: "#4F8EF7", border: "1px solid #4F8EF740", cursor: "pointer", fontFamily: "inherit", fontWeight: 700 }}>
                      {confirmId === h.id ? "✕ キャンセル" : "📋 この設定でコピー作成"}
                    </button>
                  )}
                </div>
              </div>

              {confirmId === h.id && (
                <div style={{ marginTop: 12, padding: "12px 14px", background: "#0A1628", borderRadius: 8, border: "1px solid #4F8EF730", animation: "fadein .2s ease" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#4F8EF7", marginBottom: 8 }}>📋 コピーする設定の確認</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 12 }}>
                    {[["🎭 アバター", h.avatarName], ["🎙️ 音声", h.voiceName], ["📁 プリセット", h.presetName || "なし"]].map(([k, v]) => (
                      <div key={k} style={{ padding: "7px 9px", background: "#060D1F", borderRadius: 6, border: "1px solid #141F38" }}>
                        <div style={{ fontSize: 10, color: "#334155", marginBottom: 3 }}>{k}</div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: "#94A3B8" }}>{v || "—"}</div>
                      </div>
                    ))}
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, color: "#94A3B8", marginBottom: 12 }}>
                    <input type="checkbox" checked={keepScript} onChange={e => setKeepScript(e.target.checked)} style={{ width: 15, height: 15, cursor: "pointer", accentColor: "#4F8EF7" }} />
                    前回の台本もそのまま引き継ぐ（チェックなし＝台本は新しく生成する）
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => handleCopy(h)} style={{ flex: 1, padding: "9px", borderRadius: 7, border: "none", cursor: "pointer", background: "linear-gradient(135deg,#4F8EF7,#7C5CFC)", color: "#FFF", fontWeight: 700, fontSize: 13, fontFamily: "inherit" }}>
                      ✅ この設定で「台本→動画」タブを開く
                    </button>
                    <button onClick={() => setConfirmId(null)} style={{ padding: "9px 16px", borderRadius: 7, border: "1px solid #141F38", background: "transparent", color: "#475569", cursor: "pointer", fontFamily: "inherit" }}>
                      キャンセル
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 6, marginTop: 9, paddingTop: 9, borderTop: "1px solid #0F1828" }}>
                {[["アバター", h.avatarName], ["音声", h.voiceName], ["プリセット", h.presetName], ["ID", h.id?.slice(0, 14) + "..."]].map(([k, v]) => (
                  <div key={k}><div style={{ fontSize: 10, color: "#1E3A5F", marginBottom: 2 }}>{k}</div><div style={{ fontSize: 11, color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v || "—"}</div></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ════════════════════════════════════════════════════════════
// TAB: 設定（管理者専用）
// ════════════════════════════════════════════════════════════
const ADMIN_PASS = "coolworks2024"; // ← ここでパスワードを変更できます

function SettingsTab({ apiKey, onSave, apiInput, setApiInput, history, presets }) {
  const [authed, setAuthed] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [passErr, setPassErr] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const handleAuth = () => {
    if (passInput === ADMIN_PASS) { setAuthed(true); setPassErr(false); }
    else { setPassErr(true); setPassInput(""); }
  };

  const handleSave = () => {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const stats = {
    total: history.length,
    make: history.filter(h => h.type === "make").length,
    convert: history.filter(h => h.type === "convert").length,
    presetCount: presets.length,
  };

  if (!authed) return (
    <div style={{ animation: "fadein .3s ease" }}>
      <PTitle icon="⚙️" title="管理者設定" sub="設定画面にアクセスするにはパスワードが必要です" />
      <div style={{ maxWidth: 400, margin: "60px auto 0" }}>
        <Panel>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>🔐</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9" }}>管理者パスワードを入力</div>
            <div style={{ fontSize: 12, color: "#475569", marginTop: 4 }}>この画面はcoolworks管理者専用です</div>
          </div>
          <input
            type="password"
            value={passInput}
            onChange={e => { setPassInput(e.target.value); setPassErr(false); }}
            onKeyDown={e => e.key === "Enter" && handleAuth()}
            placeholder="パスワードを入力..."
            style={{ ...iSt, marginBottom: 8, border: `1px solid ${passErr ? "#EF4444" : "#141F38"}`, textAlign: "center", letterSpacing: 4 }}
          />
          {passErr && <div style={{ textAlign: "center", fontSize: 12, color: "#EF4444", marginBottom: 8 }}>パスワードが違います</div>}
          <Btn onClick={handleAuth} variant="primary" style={{ width: "100%" }}>ログイン</Btn>
        </Panel>
      </div>
    </div>
  );

  return (
    <div style={{ animation: "fadein .3s ease" }}>
      <PTitle icon="⚙️" title="管理者設定" sub="HeyGen APIキーの設定・利用状況の確認ができます" />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {/* APIキー設定 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel title="🔑 HeyGen APIキー設定" accent="#4F8EF7">
            <div style={{ marginBottom: 12, padding: "10px 12px", background: "#030810", borderRadius: 8, border: "1px solid #0F1A30" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 6 }}>現在の接続状態</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: apiKey ? "#10B981" : "#EF4444" }} />
                <span style={{ fontSize: 13, fontWeight: 700, color: apiKey ? "#10B981" : "#EF4444" }}>{apiKey ? "接続済み" : "未設定"}</span>
              </div>
              {apiKey && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#334155", fontFamily: "monospace" }}>
                  {showKey ? apiKey : apiKey.slice(0, 8) + "••••••••••••••••••••••••"}
                  <button onClick={() => setShowKey(!showKey)} style={{ marginLeft: 8, background: "none", border: "none", color: "#4F8EF7", cursor: "pointer", fontSize: 11 }}>
                    {showKey ? "隠す" : "表示"}
                  </button>
                </div>
              )}
            </div>

            <FL label="新しいAPIキーを入力" />
            <input
              value={apiInput}
              onChange={e => setApiInput(e.target.value)}
              placeholder="hg_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              style={{ ...iSt, fontFamily: "monospace", marginBottom: 10 }}
            />

            <div style={{ marginBottom: 12, padding: "10px 12px", background: "#0A1628", borderRadius: 8, border: "1px solid #141F38", fontSize: 12, color: "#475569", lineHeight: 1.8 }}>
              <b style={{ color: "#94A3B8" }}>APIキーの取得手順：</b><br />
              1. <a href="https://app.heygen.com" target="_blank" rel="noreferrer" style={{ color: "#4F8EF7" }}>app.heygen.com</a> にログイン<br />
              2. 右上アイコン → Settings → API<br />
              3. 「Generate API Key」をクリック<br />
              4. 表示されたキーをコピーして上に貼り付け
            </div>

            <Btn onClick={handleSave} variant="primary" style={{ width: "100%" }}>
              {saved ? "✅ 保存しました" : "💾 APIキーを保存する"}
            </Btn>
          </Panel>

          <Panel title="📋 プランと機能の対応表" accent="#7C5CFC">
            {[
              ["台本→アバター動画生成", "Creatorプラン以上", "$29/月", true],
              ["カスタムアバター登録", "Creatorプラン以上", "$29/月", true],
              ["動画→キャラ変換（リップシンク）", "Businessプラン以上", "$89/月", false],
              ["ファイルアップロード", "Businessプラン以上", "$89/月", false],
            ].map(([feat, plan, price, basic]) => (
              <div key={feat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #0F1828", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#E2E8F0" }}>{feat}</div>
                  <div style={{ fontSize: 10, color: "#334155", marginTop: 2 }}>{plan}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: basic ? "#10B981" : "#F59E0B" }}>{price}</div>
                </div>
              </div>
            ))}
          </Panel>
        </div>

        {/* 利用状況 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Panel title="📊 利用状況" accent="#10B981">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
              {[
                ["総制作本数", stats.total, "本", "#4F8EF7"],
                ["台本→動画", stats.make, "本", "#10B981"],
                ["キャラ変換", stats.convert, "本", "#EC4899"],
                ["プリセット数", stats.presetCount, "件", "#7C5CFC"],
              ].map(([label, val, unit, color]) => (
                <div key={label} style={{ padding: "12px 14px", background: "#030810", borderRadius: 8, border: "1px solid #0F1828" }}>
                  <div style={{ fontSize: 11, color: "#334155", marginBottom: 4 }}>{label}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                    <span style={{ fontSize: 24, fontWeight: 800, color }}>{val}</span>
                    <span style={{ fontSize: 11, color: "#334155" }}>{unit}</span>
                  </div>
                </div>
              ))}
            </div>

            {history.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#64748B", marginBottom: 8 }}>最近の制作</div>
                {history.slice(0, 5).map(h => (
                  <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #0A1020", fontSize: 11 }}>
                    <div>
                      <span style={{ color: h.type === "make" ? "#4F8EF7" : "#EC4899" }}>{h.type === "make" ? "✏️" : "🔄"}</span>
                      <span style={{ color: "#94A3B8", marginLeft: 5 }}>{h.product || h.avatarName || "動画"}</span>
                    </div>
                    <span style={{ color: "#334155" }}>{h.createdAt}</span>
                  </div>
                ))}
              </>
            )}
          </Panel>

          <Panel title="⚠️ 注意事項" accent="#F59E0B">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                "APIキーはこのブラウザのローカルストレージに保存されます",
                "スタッフがこの設定画面にアクセスするにはパスワードが必要です",
                "APIキーを他人と共有しないでください",
                "動画生成ごとにHeyGenのクレジットが消費されます",
                "商用利用はHeyGenの有料プランが必要です",
              ].map(msg => (
                <div key={msg} style={{ display: "flex", gap: 8, fontSize: 12, color: "#64748B" }}>
                  <span style={{ color: "#F59E0B", flexShrink: 0 }}>•</span>
                  <span>{msg}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="🔐 パスワード変更方法">
            <div style={{ fontSize: 12, color: "#475569", lineHeight: 1.9 }}>
              App.jsxファイルの以下の行を編集してください：<br />
              <code style={{ display: "block", marginTop: 8, padding: "8px 10px", background: "#030810", borderRadius: 6, color: "#10B981", fontFamily: "monospace", fontSize: 11 }}>
                const ADMIN_PASS = "coolworks2024";
              </code>
              <span style={{ fontSize: 11, color: "#334155", display: "block", marginTop: 6 }}>
                この値を変更してVercelに再デプロイすると新しいパスワードが反映されます。
              </span>
            </div>
          </Panel>
        </div>
      </div>

      <div style={{ marginTop: 14, textAlign: "right" }}>
        <button onClick={() => setAuthed(false)} style={{ fontSize: 12, color: "#334155", background: "none", border: "1px solid #141F38", borderRadius: 6, padding: "5px 12px", cursor: "pointer" }}>
          🔓 管理者ログアウト
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ════════════════════════════════════════════════════════════
function Splash() { return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#060D1F", color: "#334155", fontFamily: "sans-serif" }}>読み込み中...</div>; }
function Stepper({ current, labels }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 4 }}>
      {labels.map((l, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, background: i < current ? "#10B981" : i === current ? "linear-gradient(135deg,#4F8EF7,#7C5CFC)" : "#1A2440", color: i <= current ? "#FFF" : "#334155", boxShadow: i === current ? "0 0 12px #4F8EF750" : "none" }}>{i < current ? "✓" : i + 1}</div>
            <div style={{ fontSize: 10, fontWeight: i === current ? 700 : 400, color: i === current ? "#CBD5E1" : i < current ? "#10B981" : "#334155", whiteSpace: "nowrap" }}>{l}</div>
          </div>
          {i < labels.length - 1 && <div style={{ width: 48, height: 2, margin: "0 3px", marginBottom: 16, background: i < current ? "#10B981" : "#1A2440" }} />}
        </div>
      ))}
    </div>
  );
}
function GenProgress({ progress, labels, jobId }) {
  return (
    <div style={{ marginTop: 20 }}>
      <Panel>
        <div style={{ textAlign: "center", padding: "32px 0" }}>
          <div style={{ fontSize: 48, display: "inline-block", animation: "spin 2.5s linear infinite", marginBottom: 14 }}>🔄</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#F1F5F9", marginBottom: 5 }}>処理中...</div>
          <div style={{ fontSize: 12, color: "#475569", marginBottom: 20 }}>完了まで数分かかります。ページを開いたままお待ちください。</div>
          <div style={{ maxWidth: 400, margin: "0 auto 20px", background: "#0A1020", borderRadius: 7, height: 9, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress}%`, background: "linear-gradient(90deg,#4F8EF7,#7C5CFC)", borderRadius: 7, transition: "width 1.5s ease" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, maxWidth: 440, margin: "0 auto" }}>
            {labels.map((label, i) => {
              const threshold = (i / labels.length) * 100;
              const done = progress > threshold + (100 / labels.length);
              const active = progress > threshold && !done;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderRadius: 6, background: done ? "#0F2A1A" : active ? "#0A1628" : "#080E20", border: `1px solid ${done ? "#10B98120" : active ? "#4F8EF720" : "#141F3810"}` }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, background: done ? "#10B981" : active ? "#4F8EF7" : "#1A2440", color: "#FFF", animation: active ? "pulse 1s infinite" : "none" }}>{done ? "✓" : active ? "●" : "○"}</div>
                  <span style={{ fontSize: 11, color: done ? "#10B981" : active ? "#94A3B8" : "#1E2A40" }}>{label}</span>
                </div>
              );
            })}
          </div>
          {jobId && <div style={{ marginTop: 12, fontSize: 10, color: "#1E3A5F", fontFamily: "monospace" }}>ID: {jobId}</div>}
        </div>
      </Panel>
    </div>
  );
}
function ARow({ a, sel, onSel, color }) {
  return <div onClick={onSel} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: "pointer", border: `1px solid ${sel ? color : "#141F38"}`, background: sel ? color + "22" : "#030810", transition: "all .15s" }}>{a.preview_image_url ? <img src={a.preview_image_url} style={{ width: 34, height: 34, borderRadius: 5, objectFit: "cover", flexShrink: 0 }} alt="" /> : <div style={{ width: 34, height: 34, borderRadius: 5, background: "#141F38", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🧑</div>}<div style={{ minWidth: 0, flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#E2E8F0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.avatar_name}</div><div style={{ fontSize: 10, color: "#1E3A5F" }}>{a.avatar_id?.slice(0, 20)}...</div></div>{sel && <span style={{ color, fontSize: 13 }}>✓</span>}</div>;
}
function VRow({ v, sel, onSel, color }) {
  return <div onClick={onSel} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 7, cursor: "pointer", border: `1px solid ${sel ? color : "#141F38"}`, background: sel ? color + "22" : "#030810", transition: "all .15s" }}><div style={{ width: 32, height: 32, borderRadius: 5, background: color + "22", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>🎙️</div><div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: "#E2E8F0" }}>{v.display_name || v.name}</div><div style={{ fontSize: 10, color: "#334155" }}>{v.gender || "—"}</div></div>{sel && <span style={{ color, fontSize: 13 }}>✓</span>}</div>;
}
function BgChip({ opt, sel, onSel }) {
  return <div onClick={onSel} style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: `2px solid ${sel ? "#4F8EF7" : "#141F38"}`, background: sel ? "#0A1E3A" : "#030810" }}><div style={{ width: 13, height: 13, borderRadius: 3, background: opt.value, border: "1px solid #ffffff22" }} /><span style={{ fontSize: 11, color: "#CBD5E1" }}>{opt.label}</span></div>;
}
function Panel({ title, accent, children, style = {} }) {
  return <div style={{ background: "#080F20", border: `1px solid ${accent ? accent + "30" : "#141F38"}`, borderRadius: 11, padding: 16, ...style }}>{title && <div style={{ fontSize: 13, fontWeight: 700, color: accent || "#64748B", marginBottom: 12 }}>{title}</div>}{children}</div>;
}
function Overlay({ children, onClose }) {
  return <div style={{ position: "fixed", inset: 0, background: "#000C", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={e => e.target === e.currentTarget && onClose()}><div style={{ background: "#080F20", border: "1px solid #1E3A5F", borderRadius: 12, padding: 22, width: "90%", maxWidth: 400 }}>{children}</div></div>;
}
function PTitle({ icon, title, sub }) { return <div style={{ marginBottom: 18 }}><h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "#F1F5F9" }}>{icon} {title}</h2><p style={{ margin: "3px 0 0", fontSize: 12, color: "#475569" }}>{sub}</p></div>; }
function MT({ children }) { return <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9", marginBottom: 6 }}>{children}</div>; }
function Sub({ children }) { return <div style={{ fontSize: 12, color: "#64748B", marginBottom: 12, lineHeight: 1.6 }}>{children}</div>; }
function FL({ label, req }) { return <div style={{ fontSize: 11, color: "#64748B", marginBottom: 4, fontWeight: 600 }}>{label}{req && <span style={{ color: "#EF4444" }}>*</span>}</div>; }
function Btn({ children, onClick, variant = "primary", size = "md", disabled, loading, style = {} }) {
  const v = { primary: { background: disabled || loading ? "#1A2440" : "linear-gradient(135deg,#4F8EF7,#6366F1)", color: "#FFF", opacity: disabled || loading ? 0.5 : 1 }, gradient: { background: disabled || loading ? "#1A2440" : "linear-gradient(135deg,#7C5CFC,#EC4899)", color: "#FFF", opacity: disabled || loading ? 0.5 : 1 }, ghost: { background: "transparent", color: "#475569", border: "1px solid #141F38" } };
  const s = { sm: { padding: "3px 10px", fontSize: 11 }, md: { padding: "7px 15px", fontSize: 12 }, lg: { padding: "10px 20px", fontSize: 13 } };
  return <button onClick={!disabled && !loading ? onClick : undefined} style={{ border: "none", borderRadius: 7, cursor: disabled || loading ? "not-allowed" : "pointer", fontFamily: "inherit", fontWeight: 700, transition: "all .15s", ...v[variant], ...s[size], ...style }}>{loading ? "⏳ 処理中..." : children}</button>;
}
function TI({ value, onChange, placeholder, style = {} }) { return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ ...iSt, ...style }} />; }
function TS({ value, onChange, opts, vals }) { return <select value={value} onChange={e => onChange(e.target.value)} style={{ ...iSt, cursor: "pointer" }}>{opts.map((o, i) => <option key={o} value={vals ? vals[i] : o}>{o}</option>)}</select>; }
function CCount({ text }) { const c = text?.length || 0; const col = c > 350 ? "#EF4444" : c > 290 ? "#F59E0B" : "#10B981"; return <span style={{ fontSize: 11, color: col }}>{c}文字 {c > 350 ? "（長い）" : c <= 300 ? "（適切）" : "（やや長め）"}</span>; }
function SSkel() { return <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>{[100, 80, 95, 70, 85].map((w, i) => <div key={i} style={{ height: 13, borderRadius: 4, background: "#141F38", width: `${w}%`, animation: "pulse 1.5s infinite", animationDelay: `${i * 0.1}s` }} />)}</div>; }
function Empty({ icon, msg }) { return <div style={{ textAlign: "center", padding: "48px 24px", background: "#080F20", border: "1px solid #141F38", borderRadius: 11 }}><div style={{ fontSize: 30, marginBottom: 7 }}>{icon}</div><div style={{ fontSize: 13, color: "#334155" }}>{msg}</div></div>; }
function Err({ msg, onClose }) { return <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 7, background: "#2A0F0F", border: "1px solid #5E1B1B", color: "#FCA5A5", fontSize: 12, marginBottom: 12 }}>⚠️ {msg}{onClose && <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 13 }}>✕</button>}</div>; }
function RecordBox({ items }) {
  return <div style={{ marginTop: 12, padding: "10px 12px", background: "#030810", borderRadius: 8, border: "1px solid #141F38" }}><div style={{ fontSize: 11, fontWeight: 700, color: "#334155", marginBottom: 7 }}>📋 使用設定（再現性記録）</div><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 5 }}>{items.map(([k, v]) => <div key={k}><span style={{ fontSize: 10, color: "#1E3A5F" }}>{k}：</span><span style={{ fontSize: 11, color: "#475569" }}>{v || "—"}</span></div>)}</div></div>;
}
const iSt = { width: "100%", padding: "7px 9px", borderRadius: 6, border: "1px solid #141F38", background: "#030810", color: "#E2E8F0", fontSize: 12, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };
