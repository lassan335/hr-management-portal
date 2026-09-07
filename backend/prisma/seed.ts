import { PrismaClient } from "@prisma/client";
import { encryptField } from "../src/lib/encryption";

const prisma = new PrismaClient();

const DOMAIN = process.env.ALLOWED_GOOGLE_DOMAIN || "kinbidhooschool.edu.mv";

async function main() {
  console.log("Seeding HR Management Portal demo data...");

  // --- Departments -----------------------------------------------------
  const [math, science, languages, admin] = await Promise.all(
    ["Mathematics", "Science", "Languages", "Administration"].map((name) =>
      prisma.department.upsert({ where: { name }, create: { name }, update: {} })
    )
  );

  // --- Staff groups ----------------------------------------------------------
  // Mirrors the legacy portal's "Staff Groups" settings page: two working-hours
  // frameworks, each with its own sign-in time and standard daily hours, used
  // by the attendance timesheet in place of the school-wide default shift.
  const [newFramework, oldFramework] = await Promise.all([
    prisma.staffGroup.upsert({
      where: { name: "New Framework" },
      create: { name: "New Framework", frameworkType: "New", signInTime: "06:45", workingHours: 8 },
      update: {},
    }),
    prisma.staffGroup.upsert({
      where: { name: "Old Framework" },
      create: { name: "Old Framework", frameworkType: "Old", signInTime: "06:45", workingHours: 6 },
      update: {},
    }),
  ]);

  // --- Leave types -------------------------------------------------------
  // Names match the legacy portal's real leave types ("View My Leave
  // Requests" screenshot); deductsBalance replaces the old name-based
  // "unpaid" string check so any leave type can opt out of balance deduction.
  const leaveTypeDefs = [
    { name: "Annual Leave", accrualRule: "1.5 days/month", deductsBalance: true },
    { name: "Sick Leave With MC", accrualRule: "1 day/month", deductsBalance: true },
    { name: "Sick Leave Without MC", accrualRule: "1 day/month", deductsBalance: true },
    { name: "Family Responsibility Leave", accrualRule: "3 days/year", deductsBalance: true },
    { name: "Unpaid Leave", accrualRule: "none", deductsBalance: false },
    { name: "Maternity/Paternity Leave", accrualRule: "one-time grant", deductsBalance: true },
    { name: "Study Leave", accrualRule: "school-configurable", isCustom: true, deductsBalance: true },
  ];
  const leaveTypes: Record<string, { id: string }> = {};
  for (const lt of leaveTypeDefs) {
    leaveTypes[lt.name] = await prisma.leaveType.upsert({
      where: { name: lt.name },
      create: lt,
      update: {},
    });
  }

  // --- Term calendar -------------------------------------------------------
  const year = new Date().getFullYear();
  await prisma.termCalendar.createMany({
    data: [
      { termName: `Term 1, ${year}`, startDate: new Date(year, 0, 15), endDate: new Date(year, 3, 30), blocksLeave: false },
      {
        termName: `Term 1 Exams, ${year}`,
        startDate: new Date(year, 3, 15),
        endDate: new Date(year, 3, 30),
        blocksLeave: true,
      },
    ],
    skipDuplicates: true,
  });

  // --- Overtime rates (per department) -------------------------------------
  for (const dept of [math, science, languages, admin]) {
    await prisma.overtimeRate.create({
      // Backdated to the start of the year (not the default "now") so the
      // sample overtime requests dated earlier this month resolve to a rate
      // instead of showing a null cost for having no rate "yet" in effect.
      data: { departmentId: dept.id, weekdayRate: 75, weekendRate: 110, holidayRate: 150, effectiveFrom: new Date(year, 0, 1) },
    });
  }

  // --- Staff ---------------------------------------------------------------
  // Device user ids 1001/1002 match backend/prisma/seed-data/zktime-sample-export.csv
  // so the ZKTime import can be demoed end to end; 9999 in that file is left
  // deliberately unmatched to exercise the admin review queue.
  // staffGroupId of null leaves the staff member on the school-wide default
  // shift (env SHIFT_START/STANDARD_DAILY_HOURS) to demo that fallback too.
  const staffDefs = [
    {
      staffId: "KS-0001",
      fullName: "Aishath Nashida",
      role: "HR_ADMIN",
      departmentId: admin.id,
      designation: "HR Manager",
      googleEmail: `hr.admin@${DOMAIN}`,
      deviceUserId: null,
      staffGroupId: null,
    },
    {
      staffId: "KS-0002",
      fullName: "Mohamed Shifau",
      role: "HOD",
      departmentId: math.id,
      designation: "Head of Mathematics",
      googleEmail: `shifau@${DOMAIN}`,
      deviceUserId: null,
      staffGroupId: newFramework.id,
    },
    {
      staffId: "KS-0003",
      fullName: "Fathimath Rasheeda",
      role: "HOD",
      departmentId: science.id,
      designation: "Head of Science",
      googleEmail: `rasheeda@${DOMAIN}`,
      deviceUserId: null,
      staffGroupId: newFramework.id,
    },
    {
      staffId: "KS-0004",
      fullName: "Ahmed Rasheed",
      role: "STAFF",
      departmentId: math.id,
      designation: "Mathematics Teacher",
      googleEmail: `arasheed@${DOMAIN}`,
      deviceUserId: "1001",
      staffGroupId: newFramework.id,
    },
    {
      staffId: "KS-0005",
      fullName: "Mariyam Shifa",
      role: "STAFF",
      departmentId: science.id,
      designation: "Science Teacher",
      googleEmail: `mshifa@${DOMAIN}`,
      deviceUserId: "1002",
      staffGroupId: newFramework.id,
    },
    {
      staffId: "KS-0006",
      fullName: "Hussain Waheed",
      role: "STAFF",
      departmentId: languages.id,
      designation: "English Teacher",
      googleEmail: `hwaheed@${DOMAIN}`,
      deviceUserId: null,
      staffGroupId: oldFramework.id,
    },
    {
      staffId: "KS-0007",
      fullName: "Aminath Wisam",
      role: "STAFF",
      departmentId: admin.id,
      designation: "Front Office Assistant",
      googleEmail: `awisam@${DOMAIN}`,
      deviceUserId: null,
      staffGroupId: oldFramework.id,
    },
  ];

  const staffByCode: Record<string, { id: string; departmentId: string }> = {};
  for (const s of staffDefs) {
    const created = await prisma.staff.upsert({
      where: { staffId: s.staffId },
      create: {
        staffId: s.staffId,
        fullName: s.fullName,
        nationalIdEnc: encryptField(`A${Math.floor(100000 + Math.random() * 900000)}`),
        dob: new Date(1985, 3, 12),
        gender: "OTHER",
        contactNumber: "+960 777-0000",
        personalEmail: `${s.staffId.toLowerCase()}@example.com`,
        homeAddress: "Th. Kinbidhoo",
        emergencyContact: "+960 777-1111",
        googleEmail: s.googleEmail,
        role: s.role as any,
        departmentId: s.departmentId,
        designation: s.designation,
        employmentType: "PERMANENT",
        dateJoined: new Date(2020, 0, 1),
        deviceUserId: s.deviceUserId,
        staffGroupId: s.staffGroupId,
      },
      update: {},
    });
    staffByCode[s.staffId] = created;
  }

  // Departments' HOD pointers
  await prisma.department.update({ where: { id: math.id }, data: { hodStaffId: staffByCode["KS-0002"].id } });
  await prisma.department.update({ where: { id: science.id }, data: { hodStaffId: staffByCode["KS-0003"].id } });

  // --- Bank details (HR/Admin-only) for a couple of staff -------------------
  // KS-0004 also has payroll figures configured, so the Payroll page has at
  // least one staff member to demo a salary slip against out of the box.
  await prisma.staffBankDetail.upsert({
    where: { staffId: staffByCode["KS-0004"].id },
    create: {
      staffId: staffByCode["KS-0004"].id,
      bankName: "Bank of Maldives",
      accountNumberEnc: encryptField("7730000123456"),
      salaryGradeEnc: encryptField("Grade 7"),
      basicSalaryEnc: encryptField("9845"),
      serviceAllowanceEnc: encryptField("4595"),
      jobAllowanceEnc: encryptField("0"),
    },
    update: {},
  });

  // --- Leave balances for current year --------------------------------------
  for (const code of Object.keys(staffByCode)) {
    for (const [name, amount] of [
      ["Annual Leave", 18],
      ["Sick Leave With MC", 12],
      ["Sick Leave Without MC", 6],
      ["Study Leave", 5],
    ] as const) {
      await prisma.leaveBalance.upsert({
        where: {
          staffId_leaveTypeId_year: { staffId: staffByCode[code].id, leaveTypeId: leaveTypes[name].id, year },
        },
        create: { staffId: staffByCode[code].id, leaveTypeId: leaveTypes[name].id, year, balanceDays: amount },
        update: {},
      });
    }
  }

  // --- Sample overtime requests (pre-approval workflow) -----------------------
  // Covers the states the legacy portal tracks: pending approval, approved but
  // work not yet done, approved + completed (payable, appears in the ledger),
  // and cancelled.
  const otMonth = new Date().getMonth();
  await prisma.overtimeRequest.createMany({
    data: [
      {
        staffId: staffByCode["KS-0004"].id,
        date: new Date(year, otMonth, 3),
        timeIn: new Date(year, otMonth, 3, 15, 0),
        timeOut: new Date(year, otMonth, 3, 17, 0),
        reason: "Extra exam prep supervision",
        status: "PENDING_HOD",
      },
      {
        staffId: staffByCode["KS-0004"].id,
        date: new Date(year, otMonth, 6),
        timeIn: new Date(year, otMonth, 6, 15, 0),
        timeOut: new Date(year, otMonth, 6, 18, 0),
        reason: "Weekend club coaching",
        status: "APPROVED",
        hodReviewerId: staffByCode["KS-0002"].id,
        hodReviewedAt: new Date(),
        hrReviewerId: staffByCode["KS-0001"].id,
        hrReviewedAt: new Date(),
      },
      {
        staffId: staffByCode["KS-0005"].id,
        date: new Date(year, otMonth, 5),
        timeIn: new Date(year, otMonth, 5, 14, 0),
        timeOut: new Date(year, otMonth, 5, 17, 0),
        reason: "Science fair setup",
        status: "APPROVED",
        workCompleted: true,
        workCompletedAt: new Date(),
        hodReviewerId: staffByCode["KS-0003"].id,
        hodReviewedAt: new Date(),
        hrReviewerId: staffByCode["KS-0001"].id,
        hrReviewedAt: new Date(),
      },
      {
        staffId: staffByCode["KS-0006"].id,
        date: new Date(year, otMonth, 2),
        timeIn: new Date(year, otMonth, 2, 15, 0),
        timeOut: new Date(year, otMonth, 2, 17, 0),
        reason: "Library stocktake (cancelled)",
        status: "APPROVED",
        cancelled: true,
        cancelledAt: new Date(),
        hodReviewerId: staffByCode["KS-0002"].id,
        hodReviewedAt: new Date(),
        hrReviewerId: staffByCode["KS-0001"].id,
        hrReviewedAt: new Date(),
      },
    ],
  });

  // --- Sample leave request ---------------------------------------------------
  await prisma.leaveRequest.create({
    data: {
      staffId: staffByCode["KS-0006"].id,
      leaveTypeId: leaveTypes["Sick Leave With MC"].id,
      startDate: new Date(year, new Date().getMonth(), 10),
      endDate: new Date(year, new Date().getMonth(), 11),
      reason: "Flu",
      status: "PENDING_HOD",
    },
  });

  // --- Sample manual time entries ----------------------------------------------
  // KS-0006 demonstrates a lunch break (deducted from hoursWorked); KS-0007
  // is a plain check-in/check-out day.
  const today = new Date();
  for (const code of ["KS-0006", "KS-0007"]) {
    const inTime = new Date(today);
    inTime.setHours(8, 5, 0, 0);
    const outTime = new Date(today);
    outTime.setHours(14, 20, 0, 0);
    const entries: { staffId: string; timestamp: Date; punchType: string; source: "MANUAL" }[] = [
      { staffId: staffByCode[code].id, timestamp: inTime, punchType: "CHECK_IN", source: "MANUAL" },
    ];
    if (code === "KS-0006") {
      const breakStart = new Date(today);
      breakStart.setHours(12, 0, 0, 0);
      const breakEnd = new Date(today);
      breakEnd.setHours(12, 30, 0, 0);
      entries.push(
        { staffId: staffByCode[code].id, timestamp: breakStart, punchType: "BREAK_OUT", source: "MANUAL" },
        { staffId: staffByCode[code].id, timestamp: breakEnd, punchType: "BREAK_IN", source: "MANUAL" }
      );
    }
    entries.push({ staffId: staffByCode[code].id, timestamp: outTime, punchType: "CHECK_OUT", source: "MANUAL" });
    await prisma.timeEntry.createMany({ data: entries });
  }

  console.log("Seed complete.");
  console.log("Dev-login staff IDs: KS-0001 (HR_ADMIN), KS-0002/KS-0003 (HOD), KS-0004..KS-0007 (STAFF)");
  console.log("Staff groups: New Framework (KS-0002, KS-0003, KS-0004, KS-0005), Old Framework (KS-0006, KS-0007), KS-0001 on default shift");
  console.log("Sample ZKTime export ready at backend/prisma/seed-data/zktime-sample-export.csv");
  console.log("  (device 1001 -> KS-0004, 1002 -> KS-0005, 9999 -> unmatched, for the review queue demo)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
