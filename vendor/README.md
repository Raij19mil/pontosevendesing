# vendor/

React 18.3.1 (UMD, produção), servido pelo nosso próprio domínio.

## Por que estes arquivos estão no Git

O `support.js` — o runtime do Claude Design Canvas que renderiza a
landing — carrega React de `unpkg.com` **em tempo de execução**, e a
página inteira depende disso: sem React, `boot()` nunca roda e o site
vai ao ar **em branco**. Não é degradação, é tela vazia.

Um CDN de terceiros no caminho crítico da página de vendas significa que
a disponibilidade do site é a disponibilidade da unpkg, e que uma rede
corporativa que bloqueie CDNs públicos vê um site quebrado. Servir do
mesmo domínio tira isso da conta.

## Como entra na página

O `build.mjs` copia esta pasta para `public/vendor/` e injeta, antes do
`<script src="support.js">`, um mapa `window.__resources` que aponta as
URLs da unpkg para `/vendor/…`. É um gancho do próprio `support.js`
(`cdnScriptFor`), não um remendo: nenhuma linha do runtime é alterada.

## Como conferir que são os bytes certos

O `support.js` fixa o SRI de cada arquivo. Os hashes abaixo são os que
ele espera, e o `build.mjs` os confere em CADA build — arquivo trocado
ou corrompido reprova o build em vez de ir para produção.

```
react.production.min.js      sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z
react-dom.production.min.js  sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1
```

Vieram do pacote oficial do npm, e o hash confere com o que o
`support.js` fixava para a unpkg — ou seja, são os mesmos bytes:

```bash
npm pack react@18.3.1 react-dom@18.3.1
tar -xzf react-18.3.1.tgz package/umd/react.production.min.js
openssl dgst -sha384 -binary package/umd/react.production.min.js | openssl base64 -A
```

## Ao atualizar o support.js

Se um `support.js` novo passar a fixar outra versão de React, o build
reprova com os dois hashes na tela. Refaça o `npm pack` na versão nova e
atualize `VENDOR` no `build.mjs`.

## Babel

`support.js` também carrega `@babel/standalone` da unpkg, mas **só** para
`x-import` de arquivos `.jsx` — que esta landing não usa, então esse
script nunca é buscado. Ficou de fora de propósito: são ~3 MB para um
caminho que não existe aqui. Se um dia a página usar `x-import` com JSX,
esse pedaço volta a depender da CDN.
