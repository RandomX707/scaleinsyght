USE [si_testbed_sqlserver];
GO

CREATE TABLE dbo.departments (
  department_id int NOT NULL CONSTRAINT PK_departments PRIMARY KEY,
  department_code nvarchar(20) NOT NULL CONSTRAINT UQ_departments_department_code UNIQUE,
  department_name nvarchar(100) NOT NULL
);
CREATE TABLE dbo.providers (
  provider_id int NOT NULL CONSTRAINT PK_providers PRIMARY KEY,
  department_id int NOT NULL,
  provider_name nvarchar(120) NOT NULL,
  specialty nvarchar(80) NOT NULL
);
CREATE TABLE dbo.patients (
  patient_id int NOT NULL CONSTRAINT PK_patients PRIMARY KEY,
  name nvarchar(120) NOT NULL,
  date_of_birth date NOT NULL,
  mrn nvarchar(40) NOT NULL CONSTRAINT UQ_patients_mrn UNIQUE,
  phone nvarchar(40) NOT NULL,
  created_at datetime2(0) NOT NULL
);
CREATE TABLE dbo.encounters (
  encounter_id int NOT NULL CONSTRAINT PK_encounters PRIMARY KEY,
  patient_id int NOT NULL,
  department_id int NOT NULL,
  provider_id int NOT NULL,
  admitted_at datetime2(0) NOT NULL,
  discharged_at datetime2(0) NULL
);
CREATE TABLE dbo.orders (
  order_id int NOT NULL CONSTRAINT PK_orders PRIMARY KEY,
  encounter_id int NOT NULL,
  department_id int NOT NULL,
  order_type nvarchar(40) NOT NULL,
  order_status nvarchar(24) NOT NULL,
  ordered_at datetime2(0) NOT NULL,
  amount decimal(9,2) NOT NULL,
  CONSTRAINT FK_orders_encounters FOREIGN KEY (encounter_id) REFERENCES dbo.encounters(encounter_id),
  CONSTRAINT FK_orders_departments FOREIGN KEY (department_id) REFERENCES dbo.departments(department_id)
);
GO

CREATE VIEW dbo.patient_encounter_summary AS
SELECT p.patient_id, COUNT_BIG(e.encounter_id) AS encounter_count
FROM dbo.patients p LEFT JOIN dbo.encounters e ON e.patient_id=p.patient_id
GROUP BY p.patient_id;
GO
CREATE VIEW dbo.department_order_summary AS
SELECT d.department_id, COUNT_BIG(o.order_id) AS order_count, COALESCE(SUM(o.amount),0) AS order_amount
FROM dbo.departments d LEFT JOIN dbo.orders o ON o.department_id=d.department_id
GROUP BY d.department_id;
GO
CREATE OR ALTER PROCEDURE dbo.count_patient_encounters @patient_id int AS
BEGIN
  SET NOCOUNT ON;
  SELECT COUNT_BIG(*) AS encounter_count FROM dbo.encounters WHERE patient_id=@patient_id;
END;
GO
CREATE OR ALTER PROCEDURE dbo.patient_order_total @patient_id int AS
BEGIN
  SET NOCOUNT ON;
  SELECT COALESCE(SUM(o.amount),0) AS order_total
  FROM dbo.orders o JOIN dbo.encounters e ON e.encounter_id=o.encounter_id
  WHERE e.patient_id=@patient_id;
END;
GO

EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'personal', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'patients', @level2type=N'COLUMN', @level2name=N'name';
EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'regulated', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'patients', @level2type=N'COLUMN', @level2name=N'date_of_birth';
EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'identifier', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'patients', @level2type=N'COLUMN', @level2name=N'mrn';
EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'personal', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'patients', @level2type=N'COLUMN', @level2name=N'phone';
EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'identifier', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'encounters', @level2type=N'COLUMN', @level2name=N'encounter_id';
EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'identifier', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'encounters', @level2type=N'COLUMN', @level2name=N'patient_id';
EXEC sys.sp_addextendedproperty @name=N'sensitivity', @value=N'identifier', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'orders', @level2type=N'COLUMN', @level2name=N'encounter_id';
GO
