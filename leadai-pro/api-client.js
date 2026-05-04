
// ============================================================
//  LeadAI Pro — API Client
//  Cole este arquivo junto ao seu frontend HTML
//  ou importe no seu projeto React/Vue
// ============================================================

const SUPABASE_URL = "https://SEU_PROJECT_ID.supabase.co";       // ← troque
const SUPABASE_ANON_KEY = "sua_anon_key_aqui";                    // ← troque

// ─── Supabase Auth ───────────────────────────────────────────
let _session = null;

export async function signUp(email, password, name) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password, data: { full_name: name } })
  });
  const data = await res.json();
  if (data.access_token) _session = data;
  return data;
}

export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (data.access_token) {
    _session = data;
    localStorage.setItem("leadai_session", JSON.stringify(data));
  }
  return data;
}

export function getSession() {
  if (_session) return _session;
  const stored = localStorage.getItem("leadai_session");
  if (stored) { _session = JSON.parse(stored); return _session; }
  return null;
}

export function signOut() {
  _session = null;
  localStorage.removeItem("leadai_session");
}

function authHeaders() {
  const session = getSession();
  if (!session?.access_token) throw new Error("Usuário não autenticado");
  return {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${session.access_token}`
  };
}

// ─── Chamada genérica de Edge Function ──────────────────────
async function callFunction(name, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// ─── Chamada REST do banco ────────────────────────────────────
async function dbQuery(table, params = "") {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: { ...authHeaders(), "Prefer": "return=representation" }
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Erro ${res.status}`);
  }
  return res.json();
}

async function dbPatch(table, id, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Prefer": "return=representation" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Erro ${res.status}`);
  }
  return res.json();
}

// ─── API Pública ──────────────────────────────────────────────

/**
 * Salva configurações do usuário (chaves de API, nicho, produto)
 */
export async function saveProfile(updates) {
  const session = getSession();
  return dbPatch("profiles", session.user.id, updates);
}

/**
 * Busca perfil do usuário
 */
export async function getProfile() {
  const session = getSession();
  const data = await dbQuery("profiles", `?id=eq.${session.user.id}&select=*`);
  return data[0];
}

/**
 * Cria uma nova busca e extrai leads do Google Maps via SerpAPI
 * @param {object} params - { niche, city, radius_km, min_rating, min_reviews, has_website }
 * @returns {object} - { search_id, total, leads }
 */
export async function extractLeads(params) {
  // 1. Cria registro de busca no banco
  const session = getSession();
  const searchRes = await fetch(`${SUPABASE_URL}/rest/v1/searches`, {
    method: "POST",
    headers: { ...authHeaders(), "Prefer": "return=representation" },
    body: JSON.stringify({
      user_id: session.user.id,
      niche: params.niche,
      city: params.city,
      radius_km: params.radius_km || 10,
      min_rating: params.min_rating || 3.5,
      min_reviews: params.min_reviews || 20,
      has_website: params.has_website || "any",
    })
  });
  const [search] = await searchRes.json();

  // 2. Chama Edge Function para extrair via SerpAPI
  const result = await callFunction("extract-leads", {
    ...params,
    search_id: search.id
  });

  return { search_id: search.id, ...result };
}

/**
 * Analisa leads com Gemini AI (score + mensagem personalizada)
 * @param {object} params - { lead_id? } ou { search_id? } ou {} (analisa todos pendentes)
 */
export async function analyzeLeads(params = {}) {
  return callFunction("ai-analyze", params);
}

/**
 * Valida se um número tem WhatsApp ativo
 * @param {string} leadId - ID do lead no banco
 */
export async function validateWhatsApp(leadId) {
  return callFunction("validate-whatsapp", { lead_id: leadId });
}

/**
 * Atualiza status do lead no funil CRM
 * @param {string} leadId
 * @param {string} status - 'new' | 'sent' | 'replied' | 'closed' | 'lost'
 * @param {number} followupDays - dias para follow-up automático
 */
export async function updateLeadStatus(leadId, status, followupDays = null) {
  return callFunction("update-lead", {
    lead_id: leadId,
    status,
    ...(followupDays !== null && { followup_days: followupDays })
  });
}

/**
 * Busca todos os leads do usuário com filtros
 * @param {object} filters - { status?, min_score?, order? }
 */
export async function getLeads(filters = {}) {
  let params = "?select=*&order=ai_score.desc.nullslast";
  if (filters.status) params += `&status=eq.${filters.status}`;
  if (filters.min_score) params += `&ai_score=gte.${filters.min_score}`;
  return dbQuery("leads", params);
}

/**
 * Busca leads com follow-up vencendo hoje
 */
export async function getFollowupsDue() {
  const today = new Date().toISOString();
  return dbQuery("leads", `?followup_at=lte.${today}&status=neq.closed&status=neq.lost&select=*`);
}

/**
 * Busca estatísticas do funil
 */
export async function getFunnelStats() {
  const leads = await getLeads();
  return {
    total: leads.length,
    new: leads.filter(l => l.status === "new").length,
    sent: leads.filter(l => l.status === "sent").length,
    replied: leads.filter(l => l.status === "replied").length,
    closed: leads.filter(l => l.status === "closed").length,
    hot: leads.filter(l => l.ai_score >= 80).length,
    conversion_rate: leads.length > 0
      ? Math.round(leads.filter(l => l.status === "closed").length / leads.length * 100)
      : 0
  };
}

// ─── Uso completo (exemplo) ───────────────────────────────────
/*
import * as API from "./api-client.js";

// Login
await API.signIn("usuario@email.com", "senha123");

// Extrair leads
const { search_id, total } = await API.extractLeads({
  niche: "Clínica de Estética",
  city: "São Paulo",
  radius_km: 10,
  min_rating: 3.5,
  min_reviews: 20,
  has_website: "no"
});
console.log(`${total} leads extraídos!`);

// Analisar com IA
const analysis = await API.analyzeLeads({ search_id });
console.log(`${analysis.analyzed} leads analisados com Gemini`);

// Validar WhatsApp
const wv = await API.validateWhatsApp("lead-uuid-aqui");
console.log(wv.has_whatsapp ? "✅ Tem WhatsApp" : "❌ Sem WhatsApp");

// Mover no funil
await API.updateLeadStatus("lead-uuid", "sent", 2); // follow-up em 2 dias

// Stats
const stats = await API.getFunnelStats();
console.log(`Taxa de conversão: ${stats.conversion_rate}%`);
*/
</parameter>
</invoke>