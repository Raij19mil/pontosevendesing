# Banco Memória — PontoSeven / `pontoseven.desing`

> Relatório completo de análise da estrutura do repositório.
> Gerado em 09/09/2026 · branch `claude/affectionate-dirac-j07u33` · commit base `8f59882`

---

## 1. Resumo executivo

Este repositório **não é uma aplicação web** — é um **projeto de design (Claude Design Canvas)** contendo **quatro versões iterativas da página de vendas (landing page)** do produto **PontoSeven**, um SaaS brasileiro de **ponto eletrônico (REP‑P)** com geofence, biometria facial e log de auditoria.

| Item | Valor |
|---|---|
| Tipo de projeto | Canvas de design (`.dc.html`) + runtime JS + design system |
| Produto retratado | PontoSeven — ponto eletrônico digital |
| Idioma do conteúdo | Português (pt‑BR) |
| Artboards | 4 versões da landing page |
| Histórico Git | **1 commit único** (`Add files via upload`) |
| Build / CI / testes | **Nenhum** (sem `package.json`, sem workflows, sem README) |
| Tamanho do `.git` | 1,3 MB |

**Os três achados mais importantes** (detalhados na seção 8):

1. 🔴 **O repositório está quebrado quando servido a partir da raiz** — as pastas `_ds/`, `assets/`, `uploads/` e `screenshots/` existem **apenas dentro do arquivo `.zip`** e não foram versionadas. Cinco referências (`styles.css`, `_ds_bundle.js`, `logo.png`, `app-screen.png`) apontam para arquivos inexistentes.
2. 🔴 **Divergência entre a promessa de marketing e o estado real do produto** — a landing afirma "100% Conforme Portaria 671"; o screenshot do próprio produto embutido na v4 exibe um aviso de que o AFD **ainda não** é o arquivo oficial exigido pela fiscalização e que **não existe geração de AEJ**.
3. 🟠 **Erosão do design system ao longo das versões** — a v1 tem zero cores fixas (100 % tokens); a v4 tem 30 ocorrências de hex hardcoded e um sistema de tokens paralelo, violando as regras de aderência declaradas em `_adherence.oxlintrc.json`.

---

## 2. Inventário completo de arquivos

### 2.1 Raiz do repositório (7 arquivos rastreados)

| Arquivo | Tamanho | Linhas | Papel |
|---|---:|---:|---|
| `PontoSeven Landing.dc.html` | 20.051 B | 283 | Artboard **v1** — base institucional |
| `PontoSeven Landing v2.dc.html` | 27.280 B | 349 | Artboard **v2** — editorial/brutalista |
| `PontoSeven Landing v3.dc.html` | 25.410 B | 324 | Artboard **v3** — SaaS moderno |
| `PontoSeven Landing v4.dc.html` | 39.047 B | 566 | Artboard **v4** — glassmorphism + canvas animado |
| `support.js` | 69.150 B | 1.911 | Runtime do Claude Design (gerado, não editar) |
| `image-slot.js` | 65.350 B | 1.225 | Web Component `<image-slot>` (scaffold copiado) |
| `.image-slots.state.json` | 172.787 B | 1 | Sidecar de persistência de imagens (base64) |
| `.thumbnail` | 29.606 B | — | Capa do projeto (WebP, sem extensão) |
| `Página de vendas Ponto Eletrônico.zip` | 850.134 B | — | **Export completo** do projeto (20 arquivos) |

### 2.2 Conteúdo do `.zip` — o projeto íntegro

O `.zip` é a **única fonte completa**. Ele contém tudo da raiz **mais** o que está faltando:

```
_ds/modernist-f2ad93fd-ad75-4927-9002-9d4b19946590/
  ├── styles.css                (10.555 B)  ← tokens + componentes  ⚠ NÃO VERSIONADO
  ├── readme.md                 ( 7.376 B)  ← guia do design system ⚠ NÃO VERSIONADO
  ├── _ds_manifest.json         ( 7.247 B)  ← catálogo de 47 tokens ⚠ NÃO VERSIONADO
  ├── _ds_bundle.js             (   303 B)  ← bundle vazio (stub)   ⚠ NÃO VERSIONADO
  └── _adherence.oxlintrc.json  ( 4.002 B)  ← regras de lint do DS  ⚠ NÃO VERSIONADO
assets/
  ├── logo.png       (152×152 RGBA)   ⚠ NÃO VERSIONADO
  └── app-screen.png (432×800 RGB)    ⚠ NÃO VERSIONADO
uploads/                              ⚠ NÃO VERSIONADO
  ├── Logo Ponto Firme-selection.png   → duplicata exata de assets/logo.png
  ├── pasted-1787976940704-0.png       → duplicata exata de assets/app-screen.png
  ├── pasted-1787635648818-0.png       (531×276, gradiente vermelho)
  └── cosmos_1985480383.jpeg           (2931×1976, 266 KB — não referenciado)
screenshots/
  └── font-check.png (JPEG, verificação de fonte) ⚠ NÃO VERSIONADO
```

**Deduplicação (MD5):** 2 dos 4 uploads são cópias byte a byte de `assets/`. `cosmos_1985480383.jpeg` (266 KB, ~31 % do zip) não é referenciado por nenhum artboard.

---

## 3. Arquitetura técnica

### 3.1 O formato `.dc.html` (Design Canvas)

Cada artboard é um documento HTML com uma estrutura própria em três partes:

```html
<script src="./support.js"></script>     <!-- runtime -->
<x-dc>
  <helmet> … </helmet>                   <!-- <head> virtual: CSS, fontes, título -->
  … markup do artboard …
</x-dc>
<script type="text/x-dc" data-dc-script data-props="{…}">
  class Component extends DCLogic { renderVals() { … } }
</script>
```

- **`<helmet>`** — bloco extraído e injetado no `<head>` real (favicon, `<link>`, `<style>`, `<title>`).
- **`{{ expr }}`** — interpolação de valores retornados por `renderVals()`.
- **`<sc-if value="{{ … }}">`** / **`<sc-for>`** — controle de fluxo declarativo.
- **`data-props`** — schema de props editáveis (`editor: enum | boolean`), expostas como controles na UI do canvas.
- **`class Component extends DCLogic`** — lógica com `state`, `setState()`, ciclo de vida React (`componentDidMount`, `componentWillUnmount`) e `React.createRef()`.

### 3.2 `support.js` — o runtime (1.911 linhas, gerado)

> `// GENERATED from dc-runtime/src/*.ts — do not edit. Rebuild with 'cd dc-runtime && bun run build'.`

IIFE compilada a partir de 18 módulos TypeScript:

| Módulo | Responsabilidade |
|---|---|
| `react.ts` | Acesso a `window.React` / `window.ReactDOM` |
| `parse.ts` | Parsing de `<x-dc>`, `data-props`, script DC |
| `boot.ts` | Bootstrap, CSS base, modo página cheia |
| `expr.ts` | Avaliador de expressões `{{ }}` |
| `encode.ts` | Mapeamento de atributos → props React (camelCase, eventos) |
| `compile.ts` | Compilação template → árvore React |
| `logic.ts` | `StreamableLogic` (base de `DCLogic`) |
| `component.ts` | `StreamableComponent` (React.Component) |
| `cdn.ts` / `external.ts` | Carregamento de dependências externas |
| `helmet.ts` | Processamento do `<helmet>`, modo design‑doc, fundo do canvas |
| `pseudo.ts` | Suporte a `style-hover` e pseudo‑estados inline |
| `registry.ts` / `runtime.ts` | Registro de componentes e loop de execução |
| `stream-state.ts` | Estado incremental durante streaming |

**Dependências externas carregadas em runtime (com SRI):**

| Recurso | Versão | Host |
|---|---|---|
| React | 18.3.1 (UMD, production) | `unpkg.com` |
| ReactDOM | 18.3.1 (UMD, production) | `unpkg.com` |
| Babel Standalone | 7.29.0 | `unpkg.com` |
| Overused Grotesk (VF) | 0.5‑alpha.2 | `cdn.jsdelivr.net` |
| Archivo | — | `fonts.googleapis.com` (via `styles.css`) |

Timeout de polling global: 30 s (`GLOBAL_POLL_TIMEOUT_MS = 3e4`).

### 3.3 `image-slot.js` — Web Component `<image-slot>` (1.225 linhas)

Placeholder de imagem preenchível pelo usuário, registrado como `customElements.define('image-slot', ImageSlot)`.

**Atributos:** `id` (chave de persistência, obrigatório), `shape` (`rect|rounded|circle|pill`), `radius`, `mask` (clip‑path), `fit` (`cover|contain`), `placeholder`, `src`, `credit`, `credit-href`.

**Persistência:** leitura via `fetch` do sidecar `.image-slots.state.json` (irmão do HTML); escrita via `window.omelette.writeFile`. Fora do runtime host, o slot é **somente leitura**. O crop (escala + offset) persiste junto com a imagem.

**Conformidade Unsplash embutida** (~60 linhas de política):
- `src` de host Unsplash **sem** `credit` → renderiza **tile de erro** em vez da foto;
- links para `unsplash.com` recebem `utm_source=claude_design&utm_medium=referral` automaticamente;
- validação de host fecha em caso de dúvida (FQDN com ponto final é normalizado).

### 3.4 `.image-slots.state.json` — o sidecar

4 slots preenchidos, **todos da v4**, com imagens WebP embutidas como data‑URI base64 (172.560 B de base64 ≈ 129 KB de binário):

| Slot ID | Base64 | Conteúdo real (decodificado) |
|---|---:|---|
| `ps4-tab-app` | 28.839 B | App do colaborador — tela "Bater Ponto" |
| `ps4-tab-painel` | 28.611 B | Painel do gestor — "Visão Geral" |
| `ps4-tab-relatorio` | 60.575 B | Tela "REP‑P & Compliância LGPD" |
| `ps4-auditoria` | 54.535 B | Tela "Log de Auditoria" |

Formato por slot: `{ "s": escala, "x": offset X, "y": offset Y, "u": "data:image/webp;base64,…" }`.

> ⚠️ **v1, v2 e v3 têm slots vazios** — os `image-slot` dessas versões (`seguranca-shot`, `ps-tab-*`, `ps-auditoria`, `ps3-tab-*`, `ps3-auditoria`) nunca foram preenchidos e renderizam apenas o placeholder.

---

## 4. Design System "Modernist"

Namespace: `Modernist_modern` · ID: `modernist-f2ad93fd-ad75-4927-9002-9d4b19946590`

### 4.1 Filosofia (do `readme.md`)

> "Plano, arquitetônico e inteiramente em Archivo: um vermelho quase‑mono sobre branco, grade modular visível, **zero raio de canto** e réguas fortes de 2 px. Nada flutua e nada é decorado."

**Regras "Do":** grade visível, tudo alinhado à esquerda (inclusive rótulos dentro de botões), acento usado com parcimônia, fotografias em preto‑e‑branco via `.grayscale`.

**Regras "Don't":** ❌ nunca arredondar canto · ❌ nunca centralizar rótulo de botão ou copy do hero · ❌ nunca suavizar as réguas · ❌ nunca colorizar imagem.

### 4.2 Tokens (47 no total)

**Cores‑papel**

| Token | Valor |
|---|---|
| `--color-bg` | `#f3f2f2` |
| `--color-surface` | `#eae9e9` |
| `--color-text` | `#201e1d` |
| `--color-accent` | `#ec3013` |
| `--color-accent-2` | `#e15b47` (stand‑in — esquema é mono) |
| `--color-divider` | `color-mix(in srgb, #201e1d 40%, transparent)` |

**Rampas tonais 100–900** geradas em OKLCH sobre escala perceptual comum: `--color-neutral-*`, `--color-accent-*`, `--color-accent-2-*` (27 tokens).

**Tipografia:** `--font-heading` / `--font-body` = `"Archivo", system-ui, sans-serif` · peso de heading `800`.

**Espaçamento (densidade 1,00×):** `--space-1` 4 px · `-2` 8 px · `-3` 12 px · `-4` 16 px · `-6` 24 px · `-8` 32 px.

**Raio:** `--radius-sm/md/lg` = **`0px`** (todos, por design).

**Elevação:** `--shadow-sm/md/lg` ajustadas ao fundo claro.

### 4.3 Classes de componente disponíveis

`.btn` (+ `.btn-primary/-secondary/-ghost/-icon/-block`) · `.tag` (+ `-accent/-accent-2/-neutral/-outline`) · `.field` `.input` `.radio` `.seg` `.seg-opt` · `.card` (+ `-kicker/-title/-body/-meta`) · `.elev-sm/md/lg` · `.nav` `.nav-brand` · `.table` · `.dialog` (+ `-backdrop/-title/-body/-actions`) · `.hr` · `.grayscale` · `.text-muted`

### 4.4 Regras de aderência (`_adherence.oxlintrc.json`)

Lint via **oxlint** que emite `warn` para:

| Padrão proibido | Mensagem |
|---|---|
| `/#[0-9a-fA-F]{3,8}\b/` | "Raw hex color — use a design-system color token via `var()`." |
| `/\b\d+px\b/` | "Raw px value — use a design-system spacing token via `var()`." |
| `font-family` ≠ Archivo | "Font not provided by the design system. Available: Archivo." |

> ⚠️ **As três regras são violadas pelas versões v2, v3 e v4** (ver §8.3). O `_ds_bundle.js` é um stub vazio (apenas registra o namespace e um array de erros).

### 4.5 Arquivos do DS ausentes no export

O `readme.md` documenta `theme.json`, `thumbnail.html`, `foundations/*.html` (5), `components/*.html` (6), `theme.html`, `templates/deck/`, `templates/landing/` e `assets/photo.jpg` — **nenhum deles está no `.zip`**. O export trouxe apenas o subconjunto mínimo (CSS + manifesto + readme + lint).

---

## 5. As quatro versões da landing — evolução

### 5.1 Comparativo

| | **v1** | **v2** | **v3** | **v4** |
|---|---|---|---|---|
| `<title>` | Ponto eletrônico completo | Registro de ponto sem margem para dúvida | Ponto eletrônico com prova jurídica | Identidade, jornada e prova |
| Estética | Institucional sóbria | Editorial / brutalista | SaaS moderno (estilo shadcn) | Glassmorphism + movimento |
| Carrega `_ds/styles.css` | ✅ | ✅ | ❌ | ✅ (mas sobrescrito) |
| Fonte | Archivo (DS) | Overused Grotesk | Overused Grotesk | Overused Grotesk |
| Sistema de tokens | `--color-*` (DS) | `--color-*` (DS) | `--fg/--muted/--border/--primary` | `--ink/--dim/--red/--glass-*` |
| Hex hardcoded | **0** | 5 | 22 | **30** |
| Raio de canto | 0 (DS) | 0 (DS) | 10 px | 22–26 px, pills 999 px |
| Seções | 4 | 5 | 5 | 5 |
| Features | 9 cards estáticos | 9 via `sc-for` | 9 via `sc-for` | 9 via `sc-for` + hover |
| Tabs de produto | ❌ | ✅ 3 tabs | ✅ 3 tabs | ✅ 3 tabs (preenchidas) |
| Animação | nenhuma | `ps-rise` | `ps-in` | canvas WebGL‑like + 8 keyframes + scroll reveal |
| Props editáveis | 2 | 2 | 2 | 1 |
| Linhas | 283 | 349 | 324 | **566** |

### 5.2 Headline por versão

| Versão | H1 |
|---|---|
| v1 | "Ponto eletrônico completo, do jeito que a fiscalização exige." |
| v2 | "O ponto bateu. / A prova ficou / **registrada.**" (3 linhas, última em acento) |
| v3 | "Ponto eletrônico que vira **prova**, não planilha." |
| v4 | "Identidade, / **jornada** / e prova." (pesos 300/800/300, última em vermelho) |

### 5.3 Navegação e âncoras

| Versão | Links do nav | IDs de seção |
|---|---|---|
| v1 | Funcionalidades · Segurança · Planos · FAQ | `funcionalidades`, `seguranca`, `planos`, `faq` |
| v2 | O que faz · Jurídico · Planos · FAQ | `como-funciona`, `o-que-faz`, `juridico`, `planos`, `faq` |
| v3 | Como funciona · Recursos · Planos · FAQ | `showcase`, `recursos`, `juridico`, `planos`, `faq` |
| v4 | Plataforma · Recursos · Planos · FAQ | `plataforma`, `recursos`, `juridico`, `planos`, `faq` |

✅ **Todas as âncoras resolvem** — nenhum link quebrado.
ℹ️ A seção `#juridico` existe em v2/v3/v4 mas em v3 e v4 não é linkada pelo nav (alcançável só por rolagem). Em v2, `#como-funciona` também é órfã no nav.

### 5.4 Destaques técnicos da v4

A v4 é a mais elaborada e a mais divergente:

- **Fundo animado em `<canvas>`**: 32 linhas de onda senoidal renderizadas a 60 fps via `requestAnimationFrame`, com **repulsão pelo cursor** (raio de influência 250 px, easing 0.1) e `ResizeObserver` para DPR (limitado a 2×).
- **Scroll reveal** via `IntersectionObserver` (`rootMargin: '0px 0px -12% 0px'`, threshold 0.05), com `unobserve` após disparo.
- **Motivos SVG gerados proceduralmente**: `fingerprint()` (42 cristas + 6 laços de núcleo) e `face()` (malha biométrica de 26 + 24 curvas, com linha de scan animada).
- **Limpeza correta** em `componentWillUnmount`: `cancelAnimationFrame`, `ro.disconnect()`, `io.disconnect()`, `removeEventListener` ×2. ✅
- **`prefers-reduced-motion`** desativa todas as animações e força `[data-reveal] { opacity: 1 }`. ✅
- **Breakpoints** em 1000 px e 640 px reconfigurando as grades. ✅

---

## 6. Modelo de conteúdo do produto

### 6.1 As 9 funcionalidades (estáveis em todas as versões)

| # | Funcionalidade | Descrição |
|---|---|---|
| 01 | Geofence múltiplo | Várias cercas virtuais por unidade/obra/cliente; batida só aceita dentro do perímetro |
| 02 | Biometria facial | Reconhecimento facial em cada batida; elimina carona de crachá |
| 03 | Controle de batidas | Entradas, saídas e intervalos validados; correção registra quem pediu e quem aprovou |
| 04 | Comprovantes de batida | Comprovante automático com data, hora e localização |
| 05 | Relatório mensal | Espelho de ponto consolidado por funcionário e unidade |
| 06 | REP‑P e LGPD | Alinhado à Portaria 671; dados nas bases legais exigidas |
| 07 | Log de auditoria | Trilha imutável de acessos, ajustes e alterações |
| 08 | Notificações | Avisos de atraso, esquecimento e pendências |
| 09 | Configurações da empresa | Unidades, jornadas, escalas, feriados, permissões por perfil |

### 6.2 Planos (idênticos nas 4 versões)

| Plano | Preço | Limite | Inclui |
|---|---|---|---|
| Básico | **R$ 100/mês** | Até 10 funcionários | Geofence + biometria, relatório mensal, comprovantes, REP‑P/LGPD |
| **Standard** (destaque padrão) | **R$ 200/mês** | Até 25 funcionários | Tudo do Básico + múltiplos geofences + log completo |
| Enterprise | **Sob consulta** | +25 funcionários | Tudo do Standard + integrações dedicadas + SLA |

A prop `highlightedPlan` (`enum: basico | standard | enterprise`, default `standard`) controla qual card recebe o destaque visual — implementado de forma diferente em cada versão (outline na v1, fundo tintado na v2, borda+sombra na v3, gradiente glass na v4).

### 6.3 Os 3 passos (v3 e v4)

1. **Configure a empresa** — unidades, jornadas, escalas, geofences, perfis de acesso
2. **A equipe bate o ponto** — celular + biometria facial dentro do perímetro, comprovante na hora
3. **Feche o mês** — espelho consolidado com log anexo, direto para a folha

### 6.4 FAQ (5 perguntas, v3/v4 via `sc-for`)

REP‑P/Portaria 671 · funcionamento do geofence · obrigatoriedade da biometria · tratamento de dados LGPD · mudança de plano.

### 6.5 Linha de estatísticas (`showStats`, removida na v4)

| Versão | Estatísticas |
|---|---|
| v1 | 100 % conforme · Múltiplos geofences · Automático · 24/7 |
| v2 | **671** Portaria atendida · **∞** Geofences · **100 %** batidas com comprovante · ~~Planilhas~~ |
| v3 | Setup em 1 dia · Sem relógio de parede · Múltiplos geofences · Espelho automático |
| v4 | *(seção e prop removidas)* |

---

## 7. O produto real (evidência nos screenshots)

Os 4 slots preenchidos da v4 são **capturas reais do produto em funcionamento**, não mockups. Elas revelam a arquitetura da aplicação:

### 7.1 Navegação lateral do painel administrativo

```
PontoSeven · REP-P · Franquias
├── Visão Geral
├── Funcionários
├── Geofences & Endereços      [ADM]
├── Registros de Ponto
├── Bater Meu Ponto
├── REP-P & Compliância        [ADM]
├── Lembretes de Ponto         [ADM]
├── Log de Auditoria           [SUPERADMIN]
└── Configurações              [SUPERADMIN]
```

**Modelo de permissões observado:** 3 níveis — usuário comum, `ADM`, `SUPERADMIN`. Rodapé identifica "Administrador Geral — Responsável Técnico".

### 7.2 Visão Geral (dashboard)

KPIs: *Funcionários ativos* · *Marcações hoje* · *Fora do geofence (hoje)* · *Total para revisar*.
Gráficos: *Horas trabalhadas — semana atual* (barras) e *Assiduidade — 4 semanas* (linha).
Tabela *Registros recentes*: Funcionário · Filial · Tipo · Hora · **Confiança** · Status.

### 7.3 REP‑P & Compliância LGPD

- **Exportações REP‑P** — botão "Baixar AFD (relatório em PDF)"
- **Espelho de Ponto Mensal** — por funcionário, com cargo, filial e PDF
- **Justificativas dos Colaboradores** — com anexo, status e ação
- **Aceites LGPD** — usuário, versão, data/hora, IP

### 7.4 Log de Auditoria

"Registro imutável — append-only · Portaria MTE 671/2021"
Colunas: `#` · Ação · Entidade · Usuário · IP · Data/Hora.
Ações capturadas: *Login efetuado*, *Logout*, *Aceite Termo LGPD (Versão 1.0)*, *Funcionário adicionado*, *Cadastro facial atualizado* e **`Registro de ponto — Entrada (Confiança Face: 79%, GeoDist: 0m)`**.

> 💡 O log expõe as duas métricas técnicas centrais do produto: **confiança do reconhecimento facial (%)** e **distância ao geofence (m)** gravadas em cada batida.

### 7.5 App do colaborador

Abas: *Bater Ponto* · *Histórico* · *Justificativas* · *Perfil*.
Estado de onboarding: aviso "Biometria facial não cadastrada" com CTA "Cadastrar Biometria Agora".
Bloco "SUA FILIAL": geofence ativo, **raio de 100 m**, link "Conferir coordenada cadastrada da filial no mapa".

---

## 8. Achados e riscos

### 8.1 🔴 Crítico — assets não versionados (repositório quebrado)

Cinco referências dos artboards apontam para arquivos que **não existem no repositório**:

| Referência | Usada em | Status |
|---|---|---|
| `_ds/modernist-…/styles.css` | v1, v2, v4 | ❌ ausente (só no `.zip`) |
| `_ds/modernist-…/_ds_bundle.js` | v1, v2, v4 | ❌ ausente (só no `.zip`) |
| `./assets/logo.png` | v1, v2, v3, v4 (favicon + nav) | ❌ ausente (só no `.zip`) |
| `./assets/app-screen.png` | v4 (mockup do hero) | ❌ ausente (só no `.zip`) |
| `./support.js` · `./image-slot.js` | todas | ✅ presente |

**Consequência:** abrir qualquer `.dc.html` direto do clone produz uma página **sem estilo do design system, sem logo e sem o mockup do app**. A v3 é a única que renderiza aceitavelmente, porque define todos os seus tokens inline.

**Correção:** extrair `_ds/`, `assets/`, `uploads/` e `screenshots/` do `.zip` e commitá‑los; depois avaliar remover o `.zip` (hoje 850 KB de conteúdo 100 % duplicado, exceto pelas pastas ausentes).

### 8.2 🔴 Crítico — alegação de conformidade divergente do produto

A landing afirma, em várias versões:

- "**100 %** Conforme Portaria 671 e LGPD" (v1)
- "**671** — Portaria atendida — REP‑P" (v2)
- "Conformidade com a Portaria 671 (REP‑P)" (lista `compliance`, v3/v4)
- "**Sim.** O sistema segue as regras da Portaria 671…" (FAQ, todas)

Porém o **screenshot do próprio produto** embutido no slot `ps4-tab-relatorio` da v4 exibe o seguinte aviso:

> ⚠️ "Este é um relatório visual em PDF para conferência interna — ainda **NÃO** é o arquivo‑texto no leiaute oficial exigido pela Portaria 671/2021 para fiscalização (Anexo II), nem existe geração de AEJ. Ver detalhes em `/docs/conformidade-671/RELATORIO-AUDITORIA.md`."

**Risco:** a página de vendas promete conformidade plena enquanto a tela exibida na própria página declara conformidade parcial. Isso é exposição jurídica direta (publicidade enganosa / CDC) num produto cuja proposta de valor **é** a conformidade. Além disso, o aviso interno fica visível ao público, pois está gravado dentro do sidecar versionado.

**Correção sugerida:** alinhar o copy ao estado real (ex.: "Alinhado à Portaria 671 — AFD oficial e AEJ em desenvolvimento") **ou** concluir a implementação do AFD Anexo II + AEJ antes de publicar, e recortar/substituir o screenshot para não exibir avisos internos.

### 8.3 🟠 Alto — erosão progressiva do design system

Ocorrências de hex hardcoded por versão (regra `no-restricted-syntax` do `_adherence.oxlintrc.json`):

```
v1  ──────────────────────────────────────────  0   ✅ 100% tokens
v2  ████                                         5
v3  ██████████████████                          22
v4  ████████████████████████                    30   🔴
```

Violações acumuladas:

| Regra do DS | v2 | v3 | v4 |
|---|:-:|:-:|:-:|
| Sem hex cru | ⚠️ 5 | ❌ 22 | ❌ 30 |
| Fonte = Archivo | ❌ Overused Grotesk | ❌ | ❌ |
| Raio = 0 px | ✅ | ❌ 10 px | ❌ 22–26 px / 999 px |
| Rótulo de botão à esquerda | ✅ | ❌ centralizado | ❌ centralizado |
| Sem "flutuar"/decorar | ✅ | ❌ sombras | ❌ glass + blur + sombras |

A v3 sequer carrega `styles.css` — é um documento autônomo com paleta própria (`#0c0a09`, `#78716c`, `#e7e5e4`, `#f5f5f4` — a família *stone* do Tailwind). A v4 carrega o DS **e o sobrescreve inteiro**, pagando o custo do CSS sem usá‑lo.

**Decisão pendente:** ou o DS "Modernist" é o padrão (e v3/v4 precisam ser reconciliadas ou descartadas), ou a direção de fato mudou (e o DS deve ser retunado em `styles.css`/`theme.json`, como o próprio readme instrui). Manter os dois em paralelo é o pior dos mundos.

### 8.4 🟠 Alto — código morto custoso na v4

Em `renderVals()` (linha 520‑533):

```js
const active = this.state.motif;          // motif nunca muda de 0
const unusedMotifs = [
  { el: this.fingerprint(), … },          // constrói 48 elementos SVG
  { el: this.face(), … },                 // constrói ~52 elementos SVG
].map(…);
// ⚠️ unusedMotifs NÃO é incluído no objeto retornado
```

`fingerprint()` e `face()` geram ~100 elementos React SVG **a cada render** e o resultado é descartado. `state.motif` é inicializado mas nunca atualizado. Como cada clique de tab dispara `setState` → re‑render, o custo é pago repetidamente sem qualquer efeito visual.

**Correção:** remover `unusedMotifs`, `state.motif`, `draw()`, `fingerprint()` e `face()` (≈115 linhas), **ou** cablear os motivos ao markup se o efeito era intencional.

### 8.5 🟡 Médio — acessibilidade

| Problema | Onde | Detalhe |
|---|---|---|
| Tabs sem `aria-selected` | v2, v3, v4 | `role="tablist"`/`role="tab"` presentes, mas **nenhum** `aria-selected`, `aria-controls`, `tabindex` ou navegação por setas. Leitores de tela não anunciam a aba ativa. |
| Painéis sem `role="tabpanel"` | v2, v3, v4 | Painéis alternam por `display:none` sem associação ARIA |
| Landmarks ausentes | v3, v4 | Zero atributos `aria-*` no documento inteiro (v1 e v2 têm 2 `aria-label` cada) |
| Contraste de texto | todas | O DS avisa que `--color-accent` (#ec3013) sobre o fundo atinge só ~3:1 — adequado para ícones e texto grande, **não** para corpo de texto. As versões usam `--color-accent-700` corretamente nos kickers ✅, mas v3/v4 usam `--primary`/`--red` puro em links de corpo ❌ |
| Botões sem destino | todas | Todos os CTAs ("Criar conta", "Falar com vendas") são `<button type="button">` sem `onClick` nem `href` — inertes por serem mockups de design |

✅ **Pontos positivos:** `alt` descritivo no mockup do app; `alt=""` correto no logo decorativo da v4; `prefers-reduced-motion` respeitado na v2 e v4; `:focus-visible` com anel de 2 px em v3 e v4.

### 8.6 🟡 Médio — higiene do repositório

| Item | Situação |
|---|---|
| `README.md` | ❌ ausente — nada explica o que é o projeto nem como abrir os arquivos |
| `LICENSE` | ❌ ausente |
| `.gitignore` | ❌ ausente |
| `package.json` / build | ❌ ausente |
| CI / workflows | ❌ ausente |
| Histórico Git | 1 commit único, mensagem genérica ("Add files via upload") |
| Nome do repositório | `pontoseven.desing` — **typo** de "design" |
| `.zip` versionado | 850 KB duplicando o conteúdo já rastreado |
| `.thumbnail` | WebP sem extensão — ferramentas não reconhecem o tipo |
| `.image-slots.state.json` | 172 KB de base64 em uma **única linha** — todo re‑preenchimento de slot reescreve o arquivo inteiro, inflando o `.git` a cada commit |
| Assets duplicados | 2 de 4 uploads são cópias exatas de `assets/` |
| Asset órfão | `cosmos_1985480383.jpeg` (266 KB) não referenciado por nenhum artboard |

### 8.7 🟡 Médio — dependência de CDNs externas

Todo o runtime depende de rede: React, ReactDOM e Babel de `unpkg.com`; Overused Grotesk de `cdn.jsdelivr.net`; Archivo de `fonts.googleapis.com`. Sem conexão (ou com CDN bloqueada), **nenhum artboard renderiza**. React e Babel têm SRI ✅; a fonte do jsDelivr aponta para uma tag **alpha** (`0.5-alpha.2`) de um repositório de terceiros, sem SRI — risco de indisponibilidade ou mudança silenciosa.

### 8.8 🔵 Baixo — observações menores

- Os `image-slot` das versões v1–v3 estão **vazios**; só a v4 tem imagens. Comparações visuais entre versões ficam injustas.
- A v2 define `#como-funciona` e a v3/v4 definem `#juridico` sem link correspondente no nav.
- `_ds_bundle.js` é um stub funcionalmente vazio (só cria `window.Modernist_modern` e `__errors`) — carregá‑lo é uma requisição sem retorno.
- O log de auditoria no screenshot exibe dados de teste reais (`admintest.com`, IPs `::ffff:0.0.0.0`, datas de 28–29/08/2026) — inofensivos, mas convém usar dados sintéticos limpos em material público.

---

## 9. Recomendações priorizadas

### Imediato (bloqueia uso do repositório)

1. **Commitar os assets ausentes** — extrair `_ds/`, `assets/`, `uploads/`, `screenshots/` do `.zip` para a raiz e versioná‑los. Sem isso o repositório não renderiza.
2. **Resolver a divergência de conformidade** — decidir entre ajustar o copy ("alinhado a" em vez de "100 % conforme") ou concluir AFD Anexo II + AEJ. Substituir o screenshot que expõe o aviso interno.
3. **Adicionar `README.md`** — o que é o projeto, como abrir os `.dc.html`, qual versão é a canônica.

### Curto prazo

4. **Escolher a versão canônica** e arquivar as demais em `versions/` (ou deletá‑las). Quatro landings vivas na raiz, sem indicação de qual vale, é a maior fonte de ambiguidade do repositório.
5. **Remover o código morto da v4** (`unusedMotifs`, `motif`, `draw`, `fingerprint`, `face` — ≈115 linhas).
6. **Corrigir a acessibilidade das tabs** — `aria-selected`, `aria-controls`, `role="tabpanel"`, navegação por setas. Correção pequena com ganho real.
7. **Preencher os `image-slot` das versões mantidas** com os screenshots reais já disponíveis.

### Médio prazo

8. **Reconciliar o design system** — ou retunar `styles.css`/`theme.json` para a direção da v4 (glass, Overused Grotesk, cantos arredondados) e reescrever `readme.md`, ou trazer v3/v4 de volta aos tokens. Rodar o `_adherence.oxlintrc.json` no CI para não regredir.
9. **Adicionar `.gitignore` e `LICENSE`**; renomear o repositório para `pontoseven.design`.
10. **Remover o `.zip` do versionamento** após confirmar que todo o conteúdo está na árvore, e usar releases do GitHub para exports.
11. **Considerar mover as imagens do sidecar** para arquivos em `assets/` referenciados por `src`, em vez de base64 inline — o `.image-slots.state.json` de 172 KB em linha única é hostil ao Git.

---

## 10. Referência rápida

### Mapa mental do projeto

```
pontoseven.desing/
│
├─ CAMADA DE APRESENTAÇÃO ────────── 4 artboards .dc.html (v1 → v4)
│    └─ formato: <helmet> + markup + class Component extends DCLogic
│
├─ CAMADA DE RUNTIME ─────────────── support.js (18 módulos TS compilados)
│    └─ React 18.3.1 + Babel 7.29.0 via unpkg (SRI)
│
├─ CAMADA DE COMPONENTES ─────────── image-slot.js (<image-slot> Web Component)
│    └─ persistência: .image-slots.state.json (4 slots v4, WebP base64)
│
├─ CAMADA DE DESIGN ──────────────── _ds/modernist-.../  ⚠ FALTANDO no repo
│    ├─ styles.css        (47 tokens + 40 classes)
│    ├─ readme.md         (filosofia + do/don't)
│    ├─ _ds_manifest.json (catálogo)
│    └─ _adherence.oxlintrc.json (3 regras de lint)
│
└─ CAMADA DE ASSETS ──────────────── assets/ uploads/ screenshots/  ⚠ FALTANDO no repo
```

### Identidade visual

| Elemento | Valor |
|---|---|
| Marca | **PontoSeven** (rodapé v4: "ponto · seven") |
| Logo | Quadrado preto com relógio estilizado; ponteiro vermelho `#ec3013` (152×152) |
| Cor de acento | `#ec3013` (vermelho‑laranja) — constante nas 4 versões |
| Tipografia canônica (DS) | Archivo 400/600/800 |
| Tipografia adotada (v2–v4) | Overused Grotesk VF 300–900 |
| Tagline recorrente | "REP‑P · Portaria 671 · LGPD" |

### Conceitos‑chave do domínio

**REP‑P** — Registro Eletrônico de Ponto por Programa · **Portaria 671/2021 (MTE)** — norma que rege o REP‑P · **AFD** — Arquivo Fonte de Dados (Anexo II, formato texto oficial) · **AEJ** — Arquivo Eletrônico de Jornada · **Espelho de ponto** — relatório mensal consolidado · **Geofence** — cerca virtual que valida a localização da batida · **Batida** — marcação de ponto · **Confiança Face** — score % do reconhecimento facial · **GeoDist** — distância em metros ao centro do geofence.

---

*Documento gerado por análise estática de 100 % dos arquivos rastreados do repositório, incluindo a extração e inspeção do `.zip`, a decodificação dos 4 slots de imagem em base64 e a leitura visual dos screenshots do produto.*
