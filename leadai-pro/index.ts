// ============================================================
//  Edge Function: asaas-webhook
//  POST /functions/v1/asaas-webhook
//
//  Recebe eventos do Asaas e atualiza o plano do usuário:
//  • PAYMENT_CONFIRMED / PAYMENT_RECEIVED → ativa plano
//  • PAYMENT_OVERDUE                       → suspende plano
//  • SUBSCRIPTION_DELETED / PAYMENT_REFUNDED → volta para Free
//
//  Configure no painel Asaas:
//  Configurações → Integrações → Webhooks → URL da função
// ============================================================
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, asaas-access-token",
};

// Créditos por plano
const PLAN_CONFIG: Record<string, { leads: number; disparos: number; plan: string }> = {
  starter: { leads: 100,  disparos: 50,         plan: "starter" },
  pro:     { leads: 500,  disparos: 99999,       plan: "pro" },
  free:    { leads: 10,   disparos: 3,           plan: "free" },
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // Verifica token do webhook Asaas (opcional mas recomendado)
    const webhookToken = Deno.env.get("ASAAS_WEBHOOK_TOKEN");
    if (webhookToken) {
      const receivedToken = req.headers.get("asaas-access-token");
      if (receivedToken !== webhookToken) {
        return new Response(JSON.stringify({ error: "Unauthorized webhook" }), { status: 401, headers: cors });
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const event = await req.json();
    console.log("Asaas webhook event:", event.event, event.payment?.id || event.subscription?.id);

    const payment     = event.payment;
    const subscription = event.subscription;

    // Extrai externalReference para identificar o user + plano
    // Formato: "user_uuid__plan_id" (definido no checkout)
    const extRef = payment?.externalReference || subscription?.externalReference || "";
    const [userId, planId] = extRef.split("__");

    if (!userId || !planId) {
      // Tenta buscar pelo asaas_subscription_id
      console.warn("No externalReference, trying subscription lookup:", subscription?.id);
      if (subscription?.id) {
        const { data: profileData } = await supabase
          .from("profiles")
          .select("id, pending_plan")
          .eq("asaas_subscription_id", subscription.id)
          .single();
        if (profileData) {
          await handlePlanActivation(supabase, profileData.id, profileData.pending_plan || "starter", event.event);
        }
      }
      return new Response(JSON.stringify({ received: true }), { headers: cors });
    }

    await handlePlanActivation(supabase, userId, planId, event.event);

    return new Response(JSON.stringify({ received: true, userId, planId, event: event.event }), {
      headers: { ...cors, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("asaas-webhook error:", err);
    // Retorna 200 mesmo em erro para Asaas não retentar em loop
    return new Response(JSON.stringify({ received: true, error: String(err) }), { status: 200, headers: cors });
  }
});

async function handlePlanActivation(supabase: any, userId: string, planId: string, event: string) {
  const cfg = PLAN_CONFIG[planId] || PLAN_CONFIG.free;

  if (["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(event)) {
    // ✅ Pagamento confirmado → ativa plano
    console.log(`✅ Ativando plano ${planId} para usuário ${userId}`);
    await supabase.from("profiles").update({
      plan:            cfg.plan,
      credits:         cfg.leads,
      disparos_limit:  cfg.disparos,
      disparos_used:   0,       // reseta disparos ao renovar
      credits_reset_at: new Date().toISOString(),
      pending_plan:    null,
      plan_expires_at: getNextMonth(),
      subscription_status: "active",
    }).eq("id", userId);

    // Registra transação no histórico
    await supabase.from("billing_events").insert({
      user_id:   userId,
      event:     "PAYMENT_CONFIRMED",
      plan:      planId,
      amount:    planId === "pro" ? 147.00 : 67.00,
      created_at: new Date().toISOString(),
    }).catch(() => {}); // tabela opcional

  } else if (event === "PAYMENT_OVERDUE") {
    // ⚠️ Pagamento atrasado → marca como suspenso (não cancela ainda)
    console.log(`⚠️ Pagamento atrasado para usuário ${userId}`);
    await supabase.from("profiles").update({
      subscription_status: "overdue",
    }).eq("id", userId);

  } else if (["SUBSCRIPTION_DELETED", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"].includes(event)) {
    // ❌ Cancelamento/estorno → downgrade para Free
    console.log(`❌ Cancelando plano para usuário ${userId} → Free`);
    const freeCfg = PLAN_CONFIG.free;
    await supabase.from("profiles").update({
      plan:               freeCfg.plan,
      credits:            freeCfg.leads,
      disparos_limit:     freeCfg.disparos,
      pending_plan:       null,
      plan_expires_at:    null,
      subscription_status: "cancelled",
      asaas_subscription_id: null,
    }).eq("id", userId);
  }
}

function getNextMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}
