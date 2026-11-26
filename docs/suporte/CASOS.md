# Casos de suporte: o que foi reportado, a causa e o que mudou

Cada divergência reportada vira uma linha aqui. **Sem nome de paciente** (este repositório é público):
use unidade, data e o papel de quem reportou. O caso completo (nomes, prints, áudio) fica na pasta local
`docs/_privado/suporte/`, fora do git.

| Data | Unidade | Reportado por | Sintoma | Causa | Resultado |
|---|---|---|---|---|---|
| 27/10 | Porto Ferreira | Líderes | Paciente de campanha agendado pela operadora não aparecia | Carência de 6 meses do lead (regra antiga) | Regra 2 (lead sem prazo): passa a contar |
| 27/10 | Jacareí 2 | Líderes | Agendamentos da Maria Clara e da operadora faltando (01–15/10) | Ecuro parou de mandar telefone nas consultas (96% vazio em out/26) | Ligação pela ficha do Chatwoot (819 → 1.067 agendados em out) |
| 27/10 | Mongaguá | Líderes | 3 vendas, dash mostrava 1 | Paciente voltou para pagar sem novo agendamento do CRC | v7 conta o pagamento do paciente de campanha no mês (visão Comissão) |
| 10/11 | — | Thauany | Paciente não achada pela busca por telefone na auditoria | O Ecuro não manda telefone; a busca só olhava o Ecuro | Busca usa o telefone do Chatwoot (PR #19). A paciente já era contada |
| 18/11 | São José 2 | Gerente (áudio) | Paciente de resgate pagou entrada + boleto de R$ 2.500; o dash mostrava só a entrada no Resgate | A recepção abriu outra consulta (Fachada) 27 min depois do Resgate e o boleto foi para ela | Regra do mesmo dia, aprovada pelo Paulo em 19/11 (PR #21): R$ 3.500 no Resgate |
| 19/11 | várias | Thauany | Leads de 31/10 aparecendo em 01–15/11 | O Chatwoot grava a data do anúncio sem hora, em UTC; clique depois das 21h (Brasília) virava o dia seguinte | Hora exata pela 1ª mensagem do dia (sync #21) + função `lead_anuncio_brt` (PR #20). 2.473 leads corrigidos, 78 mudaram de mês |
| 24/11 | 37 unidades | Alerta ntfy | "71 diffs em 37 unidades" | Validação rodada à mão antes do sync do dia (falso alarme) | `validate-counts` só valida dias já sincronizados (sync #23) |
| 24/11 | Campos do Jordão | Alerta ntfy | `sync-ecuro` com 1 erro todo dia | ID do Ecuro inválido no cadastro (`unitConfigs`) | Vira aviso `cadastro_invalido` (sync #22). Corrigir o cadastro: [BACKLOG](../contexto/BACKLOG.md) |

## Como tratar um caso novo

1. Pegar unidade, período, paciente (nome ou telefone) e o número que a pessoa esperava.
2. Reproduzir na auditoria do dash e no banco (só leitura).
3. Classificar: **bug** (corrige pela esteira), **regra** (explica com a página de regras) ou **regra
   nova** (leva à gerência; não muda sozinho).
4. Responder em até 24 h úteis e registrar aqui.
