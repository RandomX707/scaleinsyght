USE [si_testbed_sqlserver];
GO
INSERT INTO dbo.departments(department_id,department_code,department_name)
VALUES (1,N'D-001',N'Cardiology'),(2,N'D-002',N'Neurology'),(3,N'D-003',N'Emergency'),
       (4,N'D-004',N'Imaging'),(5,N'D-005',N'Laboratory'),(6,N'D-006',N'Surgery');

WITH n AS (
  SELECT TOP (24) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.providers(provider_id,department_id,provider_name,specialty)
SELECT n,((n-1)%6)+1,N'Provider '+RIGHT(N'000'+CONVERT(nvarchar(10),n),3),
       CHOOSE(((n-1)%4)+1,N'General',N'Cardiology',N'Radiology',N'Surgery')
FROM n;

WITH n AS (
  SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.patients(patient_id,name,date_of_birth,mrn,phone,created_at)
SELECT n,N'Patient '+RIGHT(N'0000'+CONVERT(nvarchar(10),n),4),
       DATEADD(day,(n*37)%26000,CONVERT(date,'1940-01-01')),
       N'MRN-'+RIGHT(N'000000'+CONVERT(nvarchar(10),n),6),
       N'555-01'+RIGHT(N'00000'+CONVERT(nvarchar(10),n),5),
       DATEADD(minute,n,CONVERT(datetime2(0),'2024-01-01T00:00:00'))
FROM n;

WITH n AS (
  SELECT TOP (700) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.encounters(encounter_id,patient_id,department_id,provider_id,admitted_at,discharged_at)
SELECT n,((n-1)%500)+1,((n-1)%6)+1,((n-1)%24)+1,
       DATEADD(hour,n,CONVERT(datetime2(0),'2025-01-01T00:00:00')),
       CASE WHEN n%7=0 THEN NULL ELSE DATEADD(day,1,DATEADD(hour,n,CONVERT(datetime2(0),'2025-01-01T00:00:00'))) END
FROM n;

WITH n AS (
  SELECT TOP (1200) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.orders(order_id,encounter_id,department_id,order_type,order_status,ordered_at,amount)
SELECT n,((n-1)%700)+1,((n-1)%6)+1,
       CHOOSE(((n-1)%4)+1,N'lab',N'medication',N'imaging',N'procedure'),
       CHOOSE(((n-1)%3)+1,N'placed',N'completed',N'cancelled'),
       DATEADD(hour,n,CONVERT(datetime2(0),'2025-01-01T00:00:00')),
       CONVERT(decimal(9,2),((n%250)+1)/2.0)
FROM n;
GO
