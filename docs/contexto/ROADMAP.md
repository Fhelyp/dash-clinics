# Roadmap

Para onde o dash vai, o que já foi entregue e o que depende de decisão. O que está em andamento e em que
ordem fica no [BACKLOG](BACKLOG.md).

## Direção

1. **Número oficial e confiável.** O dash substitui as contagens paralelas (planilha, filtro do
   Chatwoot). Toda divergência reportada vira caso: causa explicada, correção ou regra.
2. **Comissão e auditoria no mesmo lugar.** Funil de campanha e ações do CRC com as regras que a gerência
   aprovou, e o caminho do número até o paciente (auditoria).
3. **Cada um vê o seu.** Gerência e líderes veem a rede/regional; a operadora acompanha o próprio resultado.
4. **Barato e estável.** Tudo agregado no servidor, pré-cálculo noturno e nada pesado no horário
   comercial (Supabase no plano básico).

## Entregue

| Quando | Marco |
|---|---|
| mai/2026 | Números calculados no servidor (RPCs); fim do cálculo no navegador |
| set/2026 | Deploy automático pelo GitHub; rollup diário (Overview em ~2 s); filtro por regional |
| 19/10 | Receita = valor vendido (boleto programado só quando pago) |
| 27/10 | Gerência decide os 10 temas de regra; **funil v7** no ar (Comissão × Safra); atribuição pela ficha do Chatwoot |
| 05/11 | **Lançamento: o dash vira o número oficial.** Ações do CRC (Lead Orgânico, Indicação, Resgate Orto), visão do operador sem R$, correção de segurança (proxy de dados removido) |
| 09/11 | Todos os filtros valem em todos os blocos; o sync traz as etiquetas `organico`/`indicacao`/`orto` |
| 10/11 | Busca por telefone na auditoria usa o telefone do Chatwoot (o Ecuro parou de mandar) |
| 19/11 | Data do lead certa para anúncio à noite (fuso); **Paulo aprova D1–D8** + regra do mesmo dia na receita do CRC |
| 24/11 | Alertas da VPS sem falso positivo; esteira com testes, homolog, versão por promoção; documentação de contexto |

## Próximos (combinados, sem regra nova)

- **Visão do operador "só o meu":** abrir já filtrado na própria operadora (casar o usuário do Chatwoot
  com o criador do agendamento no Ecuro). Pendência registrada em 05/11.
- **Funil e CRC mais rápidos sem cache** (~16 s hoje na rede/mês): pré-cálculo no rollup noturno, no
  mesmo modelo do Overview.
- **Sessão revogável:** logout e desativação de usuário valerem na hora, sem esperar as 12 h do token.

## Dependem de definição da gerência

- **Visão por evento** (pedida em 27/10 e 05/11; falta definir o que é evento).
- **Estornos** como indicador separado (regra 8 de 27/10: "melhoria futura"). Hoje o pagamento negativo
  existe no Ecuro e não é descontado.
- **Divergências manual de auditoria × regras de 27/10** (D5 do documento de 09/11, só registradas):
  orgânico de tráfego pago, família como orgânico ou indicação.

## Futuro (registrado, sem data)

- Integração com o Business Manager do Facebook (cliques e conversas → agendamento).
- Contatos únicos por unidade a partir dos projetos da Maria Clara (só leitura).
