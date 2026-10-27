CREATE OR REPLACE FUNCTION public.clinics_sync_status()
 RETURNS TABLE("Unidade" text, regional text, clinic_id text, last_created timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  WITH agg AS (
    SELECT clinic_id, max(created_at) AS last_created
    FROM "BI Appointments"
    GROUP BY clinic_id
  )
  SELECT u."Unidade"::text, u.regional::text, u."Ecuro_clinicId"::text AS clinic_id, a.last_created
  FROM "unitConfigs" u
  LEFT JOIN agg a ON a.clinic_id = u."Ecuro_clinicId"
  WHERE u."Ecuro_clinicId" IS NOT NULL AND u."Ecuro_clinicId" <> '' AND u."Dash" IS TRUE;
$function$;
