-- AlterTable
ALTER TABLE "OvertimeRequest" ADD COLUMN     "selectedSupervisorId" TEXT;

-- AddForeignKey
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_selectedSupervisorId_fkey" FOREIGN KEY ("selectedSupervisorId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
