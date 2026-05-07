-- AlterTable: GroupCoordination — add candidateDays for host-confirmed date list
ALTER TABLE "GroupCoordination" ADD COLUMN "candidateDays" JSONB;
