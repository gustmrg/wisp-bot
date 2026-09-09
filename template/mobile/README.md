# Wisp · mock mobile

Mock independente em HTML e CSS, baseado nos componentes atuais e na referência
`docs/screenshot.png`. Não é importado pelo aplicativo e não modifica o runtime.

## Abrir

Abra `index.html` diretamente no navegador; não precisa de build ou dependências.
A fonte Geist e os ícones estão incluídos localmente.

Para acessar pelo celular na mesma rede, execute a partir da raiz do projeto:

```sh
python3 -m http.server 4174 --bind 0.0.0.0 --directory template/mobile
```

No computador, abra `http://localhost:4174`. No celular, use o IP local do
computador na porta 4174. Encerre o servidor com Ctrl+C quando terminar.

## Validar

- **Conversas:** lista de seis Wisps, filtros Todos/Não lidos/Em atividade e
  navegação para uma conversa própria de cada agente.
- **Chief of Staff:** conversa, resumo de tarefas e acesso às configurações.
- **Inbox Manager:** cartão de aprovação, com decisão simulada em HTML/CSS.
- **Configurações do Wisp:** Geral, Modelo e Uso; contexto e memória expansíveis.
- **Ajustes:** tema claro/escuro aplicado a todas as telas e controles de exemplo.
- **Criar Wisp:** formulário e seleção de cor do avatar.
- **Busca:** resultado fixo de exemplo, com acesso à conversa correspondente.

Acima de 760px, há uma moldura de celular com navegação auxiliar para revisão.
Até 760px, a interface ocupa a tela, usa altura dinâmica e respeita as safe areas.
O cabeçalho e o compositor ficam fora da área rolável de mensagens. A barra de
status e o indicador de início ilustrativos só aparecem na moldura desktop.

Navegação usa âncoras e `:target`; filtros, temas e abas usam controles nativos e
`:has()`. O mock exige um navegador atual com suporte a esses seletores. Respeita
redução de movimento e permite navegação por teclado e zoom.

## Limites intencionais

Dados, estados de trabalho e custos são fictícios. Os campos são editáveis apenas
para experimentar a interface. Envio, gravação de áudio, criação de agentes e
salvamento estão desabilitados; busca não executa consultas. Alterações visuais
não são persistidas pelo mock e não afetam o app existente.

Este estudo **não implementa uma PWA**: não inclui manifesto, service worker,
instalação, operação offline ou conexão remota com o backend Electron. Essas
decisões ficam para depois da validação da interface.

Os desenhos dos Wisps e as cores reproduzem `src/components/wisp.tsx`,
`src/lib/wisp-appearance.ts` e `styles.css`. A licença da fonte está em
`assets/Geist-LICENSE.txt`.
