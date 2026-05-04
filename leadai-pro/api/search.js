export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { niche, city, minRating, minReviews, serpKey, geminiKey } = req.body;

  try {
    const serpRes = await fetch(
      `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(niche)}+em+${encodeURIComponent(city)}&type=search&api_key=${serpKey}`
    );
    const serpData = await serpRes.json();
    const places = (serpData.local_results || []).filter(p =>
      (p.rating || 0) >= parseFloat(minRating) &&
      (p.reviews || 0) >= parseInt(minReviews)
    ).slice(0, 10);

    const leads = await Promise.all(places.map(async (p, i) => {
      const phone = p.phone || "";
      const ddd = phone.replace(/\D/g,"").substring(0,2);
      const prompt = `Você é um analista de vendas. O negócio "${p.title}" em ${city} tem nota ${p.rating} com ${p.reviews} avaliações. Snippet: "${p.snippet||""}". Responda APENAS JSON: {"score":0-100,"pain_points":["dor1","dor2"],"message":"mensagem personalizada de prospecção de 2 linhas","score_label":"Quente 🔥 ou Morno ⚡ ou Frio ❄️"}`;
      
      let ai = { score: 50, pain_points: ["sem informação"], message: `Olá! Vi seu negócio no Google Maps e gostaria de apresentar uma solução.`, score_label: "Morno ⚡" };
      
      try {
        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${geminiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const gData = await gRes.json();
        const text = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const json = text.match(/\{[\s\S]*\}/)?.[0];
        if (json) ai = JSON.parse(json);
      } catch(e) {}

      return {
        id: i + 1,
        name: p.title,
        segment: niche,
        city: city,
        phone: phone,
        has_whatsapp: !!phone,
        rating: p.rating || 0,
        review_count: p.reviews || 0,
        website: p.website || null,
        status: "new",
        pain_points: ai.pain_points || [],
        ai_score: ai.score || 50,
        ai_message: ai.message || "",
        score_label: ai.score_label || "Morno ⚡",
        history: [{ type: "extracted", label: "Lead extraído via Google Maps", ts: Date.now() }]
      };
    }));

    res.status(200).json({ leads });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
