# Auditoria UX / CRO / Acessibilidade / Performance / Segurança — PontoSeven

**Fase 0 — Reconhecimento.** Somente leitura, nenhum arquivo de produto foi alterado.
Data: 2026-09-23.

---

## 1. Correção de premissas — stack real do projeto

O prompt original presumia React/Vite/Next.js, Tailwind, Supabase, n8n, WhatsApp, GTM e Meta Pixel.
**Nenhuma dessas premissas corresponde a este projeto.** Stack real, confirmada em `package.json`,
`vercel.json` e `build.mjs`:

| Item | Realidade do projeto |
|---|---|
| Framework de build | Nenhum bundler (sem Vite/Next/webpack). Fonte é `PontoSeven Landing v4.dc.html`, arquitetura própria "Design Canvas" (`support.js` + diretivas `<sc-if>`/`<sc-for>`) |
| UI runtime | React 18, mas **auto-hospedado** em `/vendor/`, verificado por hash SHA-384 no build — não vem de CDN nem de `npm install react` |
| CSS | CSS nativo, sem Tailwind |
| Banco de dados | Postgres direto via `pg` — **não é Supabase** |
| Pagamento | Stripe direto (`stripe` ^17.5.0), checkout hospedado |
| Automação | Nenhum n8n |
| Contato/conversão | E-mail (`suporte@`, `comercial@seteponto.cloud`) — **não há WhatsApp** em nenhum lugar do código |
| Analytics/tracking | Nenhum GTM, GA ou Meta Pixel encontrado |
| Deploy | Vercel — `vercel.json` presente, build command `node build.mjs`, output `public/` |
| Dependências (produção) | Somente `pg` e `stripe` |
| Testes | `node --test tests/**/*.test.mjs` (suíte própria, 26 testes E2E) |
| Lint | **Não existe script de lint configurado.** O portão de qualidade hoje é `build.mjs` (checagem de integridade de referências + SRI) e a suíte de testes. Isso muda o que a Fase 6 pode rodar. |

Todas as fases abaixo foram replanejadas para esta stack real, não para a presumida.

---

## 2. Mapa do site

| Rota | Arquivo fonte | Função |
|---|---|---|
| `/` | `PontoSeven Landing v4.dc.html` | Landing principal: hero, recursos, planos, FAQ, modal de cadastro embutido |
| `/entrar` | `paginas/entrar.html` | Login (e-mail + senha) |
| `/bem-vindo` | `paginas/bem-vindo.html` | Retorno do Stripe Checkout, libera acesso |
| `/obrigado-vendas` | `paginas/obrigado-vendas.html` | Pós-venda Enterprise (contato comercial) |
| `/termos` | `paginas/termos.html` | Termos de Uso (rascunho, indexável) |
| `/privacidade` | `paginas/privacidade.html` | Política de Privacidade (rascunho, indexável) |
| `/404` | `paginas/404.html` | Página de erro, publicada como arquivo solto (convenção Vercel) |

**Componentes-chave da landing:** nav fixo (logo, links "Recursos/Planos/FAQ" via `[data-nav-links]`,
"Entrar"/"Criar conta"), hero com H1 único + subtítulo + CTA, grade de recursos (`[data-grid="three"]`),
seção de planos (grade de cards), FAQ, modal de cadastro em 2 etapas (dados → plano), modal de demo,
aviso de cookies (`position:fixed`, canto inferior).

**Fontes:** Overused Grotesk, único arquivo `.woff2`, via `@font-face` apontando para
`cdn.jsdelivr.net` (versão fixa `@0.5-alpha.2`).

**Script de terceiros:** nenhum, exceto a fonte acima. Sem chat, sem pixel, sem analytics.

---

## 3. Conversão primária

**"Criar conta"** → abre o modal de cadastro embutido na própria landing → Stripe Checkout hospedado
→ retorno em `/bem-vindo`. Confirmado pela estrutura do código (é o único fluxo com formulário,
validação client-side e integração de pagamento) e pela ausência de qualquer outro CTA concorrente
(sem WhatsApp, sem formulário de contato genérico como conversão principal).

---

## 4. Achados classificados

### 🔴 Crítico

Nenhum encontrado. Não há segredos expostos, XSS explorável ou falha que bloqueie totalmente a
conversão.

### 🟠 Alto

1. **Sem menu mobile substituto abaixo de 1000px.**
   `[data-nav-links] { display: none !important; }` (CSS da v4, breakpoint `max-width: 1000px`)
   esconde os links Recursos/Planos/FAQ sem hambúrguer, drawer ou qualquer substituto. Confirmado
   ao vivo: nenhum botão com `aria-label`/texto de "menu" existe no DOM em 375px.
   Mitigado parcialmente por ser site de página única (as seções continuam alcançáveis por scroll)
   e pelos botões "Entrar"/"Criar conta" ficarem em `<div>` separada, continuando visíveis.

2. **Banner de cookies sobrepõe visualmente o CTA primário do hero em mobile na primeira visita.**
   O aviso (`position:fixed; bottom:0; z-index:90`) aparece sempre que `localStorage` não tem
   `ps_cookies_ok`. Screenshot em 375×667 confirma: o CTA "Criar conta" do hero (rect
   `top:606 bottom:661`) fica atrás do cartão do aviso. Mitigado por o CTA do nav (topo,
   131×38) permanecer visível e clicável — a conversão não fica bloqueada, mas o CTA
   pensado como principal da dobra some exatamente na primeira impressão de um visitante novo.

3. **14 de 28 elementos clicáveis medidos abaixo de 44×44px em mobile (375px).** Amostra:
   - "Criar conta" do nav — 131×38
   - "Entendi" do banner de cookies — 98×36
   - Setas "Etapa anterior" / "Próxima etapa" do carrossel — 40×40 cada
   - Abas "Como funciona" / "Dashboard e relatórios" — 37px de altura
   - "Entrar na plataforma" — 74×37

4. **Cabeçalhos de segurança ausentes em `vercel.json`.** Hoje só existem
   `X-Content-Type-Options`, `Referrer-Policy` e `X-Frame-Options`. Faltam:
   `Strict-Transport-Security`, `Permissions-Policy` e `Content-Security-Policy` (mesmo em modo
   Report-Only).

5. **Contraste do texto branco sobre o vermelho da marca (`#ec3013`) ≈ 4,2:1.**
   Medido ao vivo (branco `rgb(255,255,255)` sobre fundo `rgb(236,48,19)`, todos os botões
   "Criar conta"/"Entendi"). Fica abaixo do mínimo 4.5:1 do WCAG 2.2 AA para texto normal — os
   botões usam 14–15px/peso 600, o que não se qualifica como "texto grande" (precisaria de
   ≥18.66px em negrito ou ≥24px). Está acima de 3:1, então passaria se tratado como componente de
   UI, mas não como texto. **Por regra do prompt: não vou alterar a cor da marca.** Nas fases
   seguintes vou propor opções (ex.: escurecer ligeiramente o vermelho só nos estados de fundo de
   botão, ou aumentar peso/tamanho da fonte do botão) e pedir confirmação antes de aplicar
   qualquer uma.

### 🟡 Médio

6. **Nenhum honeypot anti-spam nos formulários** (cadastro, demo, login). Hoje a única defesa
   contra automação é rate-limit no servidor (`lib/limite.js`, por IP).
7. **Nenhum elemento `<main>` na landing principal.** As páginas de fluxo (`/entrar`, etc.) têm
   `<main>`; a v4 não tem nenhum (`document.querySelectorAll('main').length === 0` ao vivo) — perde
   o landmark de "pular para o conteúdo principal" para leitores de tela.
8. **Breakpoints atuais são desktop-first (`max-width`)**, não mobile-first (`min-width`) como a
   Fase 1 pede. Não é um bug hoje, mas é a reestruturação central da Fase 1.
9. **Sem `npm run lint`.** A Fase 6 vai rodar `npm run build` + `npm test` como portão — não existe
   comando de lint para incluir.

### 🟢 Baixo / informativo

10. **SRI (`integrity`) não é aplicável ao único recurso de CDN** (a fonte, carregada via
    `@font-face { src: url(...) }` no CSS). O atributo `integrity` só existe para tags
    `<link>`/`<script>`, não para `url()` dentro de CSS — limitação da plataforma web, não uma
    lacuna deste projeto. (Nota à parte: o React, que É carregado via `<script>`, já é
    auto-hospedado com verificação de hash SHA-384 no build — mecanismo equivalente e mais forte
    que SRI, porque reprova o build inteiro se o arquivo mudar.)
11. **Sem WhatsApp em lugar nenhum do código** — as únicas menções à palavra são comentários sobre
    como crawlers de redes sociais leem Open Graph. Contato é sempre por e-mail.

### O que já está correto (não mexer, só confirmar que continua assim)

- Nenhum segredo hardcoded no frontend.
- Nenhum vetor de XSS explorável — todo `innerHTML` do projeto usa literais fixos ou lookup em
  dicionário controlado (`SAIDAS`); dado digitado pelo usuário (nome) já usa `textContent`.
- Os 4 usos de `target="_blank"` já têm `rel="noopener noreferrer"`.
- `npm audit`: **0 vulnerabilidades**.
- Campos de formulário (cadastro, demo, login) já usam `type`, `inputmode` e `autocomplete`
  corretos (`email`/`tel`/`name`/`username`/`new-password`/`current-password`), com `<label>`
  visível — não só `placeholder`. Pouco trabalho esperado aqui na Fase 3.
- Sem rolagem horizontal em 375px.
- H1 único na página; hero tecnicamente entrega H1 + subtítulo + CTA antes do fim da primeira
  dobra (o problema é a sobreposição do banner de cookies, achado #2, não a ausência do CTA).
- `prefers-reduced-motion: reduce` já é respeitado.
- Um único cookie (sessão, `HttpOnly`+`Secure`+`SameSite=Lax`), sem rastreamento — o aviso já
  existente já descreve isso com precisão.
- `viewport` já é seguro (`width=device-width, initial-scale=1`, sem `user-scalable=no`).

---

## 5. Plano de ação por fase

- **Fase 1 (Fundação responsiva):** migrar os breakpoints de `max-width` para `min-width`
  (achado #8), variáveis fluidas com `clamp()`, `100dvh`/`svh` onde há altura de viewport,
  `env(safe-area-inset-*)` nos elementos fixos (nav sticky, CTA bar futura, banner de cookies).
- **Fase 2 (Hierarquia/eye tracking):** resolver a sobreposição banner×CTA (achado #2) — provável
  solução: recuar o banner para não colidir com a zona do CTA do hero, ou reduzir a chance de
  colisão com `padding-bottom` reservado; ajustar contraste dos botões (achado #5) com opções para
  eu aprovar.
- **Fase 3 (Ergonomia de toque):** aumentar os 14 alvos abaixo de 44px (achado #3); desenhar o
  menu mobile que hoje não existe (achado #1) — hambúrguer com foco preso, ESC, tap-fora; CTA bar
  fixa no rodapé para mobile.
- **Fase 4 (Performance):** medir Core Web Vitals hoje (baseline) antes de mexer; `font-display:
  swap` na fonte; nenhum script de terceiro para adiar além da própria fonte.
- **Fase 5 (Segurança):** adicionar HSTS e Permissions-Policy (diretos, baixo risco); montar CSP a
  partir dos domínios reais (`cdn.jsdelivr.net`, `unpkg.com` só como fallback comentado já que o
  React é local, domínio da Stripe para o checkout) e **subir em Report-Only primeiro**, listar
  domínios e pedir confirmação antes de bloquear; adicionar honeypot aos 3 formulários (achado #6).
- **Fase 6 (Verificação):** `npm run build` + `npm test` como portão (achado #9 — sem lint
  configurado); testar a matriz de larguras pedida; Lighthouse mobile antes/depois.

---

## 6. Aguardando confirmação

Fase 0 concluída. Nenhum arquivo de produto foi alterado — só este relatório foi criado.

Antes de iniciar a Fase 1, preciso do seu **"ok"**, conforme combinado. Também vou parar e
perguntar, dentro das fases, nos pontos que a regra exige: qualquer ajuste de tom/fundo para
resolver o contraste do vermelho (achado #5), antes de ativar a CSP em modo bloqueante, e antes de
qualquer dependência nova (não estou prevendo nenhuma até agora — tudo dá para fazer com CSS/JS
nativo).
