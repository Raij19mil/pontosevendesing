# capturas/

Capturas de tela que aparecem nos `<image-slot>` da landing.

## Como adicionar

1. Suba o arquivo **nesta pasta**, com o nome do slot de destino.
2. Rode `node scripts/importar-imagens.mjs capturas`.
3. Rode `npm run build`.

O passo 2 grava a imagem em `.image-slots.state.json` — que é o arquivo
que a página realmente lê. **Subir o PNG aqui, sozinho, não muda a
página**: o original fica guardado para poder ser reimportado depois
(trocar o enquadramento, subir a qualidade, refazer o corte).

## Nomes aceitos

O nome do arquivo, sem extensão, precisa ser o id do slot:

| Arquivo | Onde aparece |
|---|---|
| `ps4-tab-app.png` | Aba **App do funcionário** (seção Plataforma) |
| `ps4-tab-painel.png` | Aba **Painel do gestor** |
| `ps4-tab-geofence.png` | Aba **Geofence** |
| `ps4-auditoria.png` | Bloco de **auditoria**, mais abaixo na página |

Aceita `.png`, `.jpg`, `.jpeg` e `.webp`. Nome fora dessa lista faz o
script parar e mostrar os válidos, em vez de gravar no lugar errado.

## Proporção

As três abas são exibidas em **4:3**. Uma captura mais larga que isso é
cortada nas laterais pelo enquadramento do slot. Capturar já perto de
4:3 (por exemplo 1280×960) evita perder conteúdo.

O script redimensiona sozinho para o lado maior de ~1200 px e converte
para WebP, com a mesma regra que o editor do canvas usa — não precisa
otimizar antes de subir.

## Duas coisas para conferir antes de subir

**Tema.** As abas usam a plataforma em **tema claro**, que é o da própria
landing. Uma captura em tema escuro destoa das outras duas.

**Dado real.** Esta é uma página de vendas **pública**. Endereço, CNPJ,
nome e e-mail de cliente que aparecerem na tela vão junto. Prefira um
ambiente com dados de demonstração.
