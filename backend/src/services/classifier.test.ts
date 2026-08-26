import { describe, it, expect } from 'vitest';
import { classify, isJob } from './classifier';

// ── True positives (must classify as 'posting') ───────────────────────────────

describe('true positives — must be posting', () => {
  it('accepts role noun + career URL', () => {
    expect(classify({ text: 'Senior Credit Analyst', href: '/careers/apply' }).type).toBe('posting');
  });

  it('accepts role noun on ATS job-detail URL', () => {
    const r = classify({
      text: 'Underwriting Credit Analyst (French Speaking)',
      href: 'https://jobs.citi.com/job/nairobi/underwriting-credit-analyst-french-speaking/287/97083872880',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts clean Habib Bank listing after title cleanup', () => {
    // Actual text from the page after cleanTitle()
    const r = classify({
      text: 'Software Engineer – BI Specialist',
      href: 'https://habibbank.com/career/software-engineer-bi-specialist/',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts QA Engineers (SDET)', () => {
    const r = classify({
      text: 'QA Engineers (SDET)',
      href: 'https://habibbank.com/career/qa-engineers-sdet/',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts PDF job description — UBA Relationship Manager', () => {
    // PDFs must NOT be vetoed — real job descriptions are published as PDFs
    const r = classify({
      text: 'Relationship Manager, Personal Banking',
      href: 'https://www.ubakenya.com/wp-content/uploads/sites/16/2025/09/JOB-DESCRIPTION-RELATIONSHIP-MANAGER-PERSONAL-BANKING.pdf',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts Senior Software Engineer on /careers/ URL', () => {
    expect(isJob({ text: 'Senior Software Engineer', href: 'https://bank.co.ke/careers/senior-software-engineer' })).toBe(true);
  });

  it('accepts Branch Manager — Nairobi', () => {
    expect(isJob({ text: 'Branch Manager — Nairobi', href: 'https://bank.co.ke/careers/branch-manager' })).toBe(true);
  });

  it('accepts DevOps Engineer', () => {
    expect(isJob({ text: 'DevOps Engineer', href: '/careers/devops' })).toBe(true);
  });

  it('accepts Data Scientist', () => {
    expect(isJob({ text: 'Data Scientist', href: '/careers/data-science' })).toBe(true);
  });

  it('accepts Personal Loans Officer (role noun rescues product word)', () => {
    expect(isJob({ text: 'Personal Loans Officer', href: '/careers/apply' })).toBe(true);
  });

  it('accepts Trade Finance Manager (role noun rescues product word)', () => {
    expect(isJob({ text: 'Trade Finance Manager', href: '/careers/trade-finance-manager' })).toBe(true);
  });

  it('accepts ATS host link with role noun in text', () => {
    const r = classify({ text: 'Credit Analyst', href: 'https://bank.myworkdayjobs.com/jobs/analyst' });
    expect(r.type).toBe('posting');
    expect(r.score).toBeGreaterThanOrEqual(5);
  });

  it('accepts Procurement Officer on /latest-vacancies URL (DIB)', () => {
    expect(classify({ text: 'Procurement Officer', href: 'https://www.dibkenya.co.ke/latest-vacancies' }).type).toBe('posting');
  });

  it('accepts Employee Relations Manager on /career_tax/ URL (Co-op)', () => {
    expect(classify({ text: 'Employee Relations Manager', href: 'https://www.co-opbank.co.ke/career_tax/co-op-bank/' }).type).toBe('posting');
  });

  it('accepts Team Leader Business Systems (BOA)', () => {
    const r = classify({
      text: 'Team Leader Business Systems',
      href: 'https://boakenya.com/jobs/team-leader-business-systems/',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts Commercial Lead on careers URL', () => {
    expect(classify({ text: 'Commercial Lead', href: 'https://hfcb.co.ke/careers/210' }).type).toBe('posting');
  });

  it('accepts Senior Credit Analyst - AVP from Citi', () => {
    const r = classify({
      text: 'Senior Credit Analyst - AVP, French Speaking',
      href: 'https://jobs.citi.com/job/nairobi/senior-credit-analyst-avp-french-speaking/287/96818347088',
    });
    expect(r.type).toBe('posting');
  });
});

// ── Hard-veto false positives from 2026-07-04 digest (must be 'reject') ──────

describe('hard vetoes — must be reject', () => {
  it('rejects Board of Directors (Bank of Baroda false positive)', () => {
    expect(classify({
      text: 'Board of Directors',
      href: 'https://www.bankofbarodakenya.co.ke/about-us/board-of-directors',
    }).type).toBe('reject');
  });

  it('rejects Board Of Directors (Consolidated Bank — different capitalisation)', () => {
    expect(classify({
      text: 'Board Of Directors',
      href: 'https://www.consolidated-bank.com/board-of-directors.php',
    }).type).toBe('reject');
  });

  it('rejects Rapidtransfer International (Ecobank product page)', () => {
    expect(classify({
      text: 'Rapidtransfer International',
      href: 'https://ecobank.com/personal-banking/payments-transfers/rapidtransfer-international',
    }).type).toBe('reject');
  });

  it('rejects Customer Feedback (Ecobank security centre)', () => {
    expect(classify({
      text: 'Customer Feedback',
      href: 'https://ecobank.com/personal-banking/security-centre/customer-feedback-survey',
    }).type).toBe('reject');
  });

  it('rejects Our Leadership (Gulf African Bank)', () => {
    expect(classify({
      text: 'Our Leadership',
      href: 'https://gulfafricanbank.com/about-us/our-leadership/',
    }).type).toBe('reject');
  });

  it('rejects Safaricom Dealers Financing (Gulf African — product page)', () => {
    expect(classify({
      text: 'Safaricom Dealers Financing',
      href: 'https://gulfafricanbank.com/financing/safaricom-dealers/',
    }).type).toBe('reject');
  });

  it('rejects APPOINTMENT NOTICE — CHIEF EXECUTIVE OFFICER (press release)', () => {
    expect(classify({
      text: 'APPOINTMENT NOTICE – CHIEF EXECUTIVE OFFICER AND EXECUTIVE DIRECTOR',
      href: 'https://gulfafricanbank.com/appointment-notice-managing-director-and-executive-director/',
    }).type).toBe('reject');
  });

  it('rejects INTERNET BANKING (M-Oriental — e-banking portal link)', () => {
    expect(classify({
      text: 'INTERNET BANKING',
      href: 'https://ib.moriental.co.ke:8443/ebanking/index.aspx',
    }).type).toBe('reject');
  });

  it('rejects Our Work Enviroment (Paramount — .jpg URL)', () => {
    expect(classify({
      text: 'Our Work Enviroment',
      href: 'https://paramountbank.co.ke/wp-content/uploads/2022/02/careers-image-1.jpg',
    }).type).toBe('reject');
  });

  it('rejects Internet Banking — SBM sbmbank portal', () => {
    expect(classify({
      text: 'Internet Banking',
      href: 'https://ibke.sbmbank.co.ke/sbm-kenya/',
    }).type).toBe('reject');
  });

  it('rejects Help & Feedback (SBM)', () => {
    expect(classify({
      text: 'Help & Feedback',
      href: 'https://www.sbmbank.co.ke/help-feedback',
    }).type).toBe('reject');
  });

  it('rejects Board of Directors — UBA', () => {
    expect(classify({
      text: 'Board of Directors',
      href: 'https://www.ubakenya.com/about-us/leadership/',
    }).type).toBe('reject');
  });

  it("rejects Analyst's Reports (UBA)", () => {
    expect(classify({
      text: "Analyst's Reports",
      href: 'https://www.ubagroup.com/investor-relations/analyst-reports/',
    }).type).toBe('reject');
  });

  it('rejects Job Simulations (Citi)', () => {
    expect(classify({
      text: 'Job Simulations',
      href: 'https://jobs.citi.com/job-simulations',
    }).type).toBe('reject');
  });

  it('rejects Manage Application (Citi workday home)', () => {
    expect(classify({
      text: 'Manage Application(opens in new window)',
      href: 'https://citi.wd5.myworkdayjobs.com/en-US/2/userHome',
    }).type).toBe('reject');
  });

  it('rejects Board of Directors — Middle East Bank', () => {
    expect(classify({
      text: 'Board of Directors',
      href: 'https://mebkenya.com/about-us/board-directors',
    }).type).toBe('reject');
  });

  it('rejects Internet Banking ×2 — Middle East Bank e-banking portal', () => {
    expect(classify({
      text: 'Internet Banking',
      href: 'https://e-bank.mebkenya.com/corporate/',
    }).type).toBe('reject');
  });

  it('rejects Corporate Internet Banking — Middle East Bank', () => {
    expect(classify({
      text: 'Corporate Internet Banking',
      href: 'https://e-bank.mebkenya.com/corporate/login.aspx',
    }).type).toBe('reject');
  });

  it('rejects International Money Transfer (UBA — product page)', () => {
    expect(classify({
      text: 'International Money Transfer',
      href: 'https://www.ubakenya.com/personal-banking/money-transfer/uba-international-money-transfer/',
    }).type).toBe('reject');
  });

  it('rejects Internet Banking — UBA personal banking path', () => {
    expect(classify({
      text: 'Internet Banking',
      href: 'https://www.ubakenya.com/personal-banking/digital-banking/internet-banking/',
    }).type).toBe('reject');
  });

  it('rejects Board of Directors — National Bank', () => {
    expect(classify({
      text: 'Board of Directors',
      href: 'https://www.nationalbank.co.ke/about-us/leadership/board-of-directors',
    }).type).toBe('reject');
  });

  // ── 2026-07-05 digest false positives ──
  it('rejects StanChart employee story URL', () => {
    expect(classify({
      text: 'Pearl shares her journey from intern to Credit Analyst.',
      href: 'https://www.sc.com/en/global-careers/our-employee-stories/pearl-chandra/',
    }).type).toBe('reject');
  });

  it('rejects Britam testimonial headline', () => {
    expect(classify({
      text: 'Leonard Chirchir Speaks On Life as An Underwriter While Working at Britam.',
      href: 'https://ke.britam.com/careers',
    }).type).toBe('reject');
  });

  it('rejects HR award headline (Jubilee)', () => {
    expect(classify({
      text: 'HR Director of the Year 2022 – HR Awards by IHRM',
      href: 'https://jubileeinsurance.com/ke/careers',
    }).type).toBe('reject');
  });

  it('rejects Directors & Officers Liability insurance product', () => {
    expect(classify({ text: 'Directors & Officers Liability', href: 'https://www.sanlam.co.ke/careers' }).type).toBe('reject');
    expect(classify({ text: 'Directors and Officers Liability', href: 'https://geminia.co.ke/careers' }).type).toBe('reject');
  });

  it('rejects BROKERS / AGENTS PORTAL (CIC)', () => {
    expect(classify({ text: 'BROKERS / AGENTS PORTAL', href: 'https://cic.co.ke/careers/' }).type).toBe('reject');
  });

  it('rejects Student Attachment Cover insurance product (Madison)', () => {
    expect(classify({ text: 'Student Attachment Cover', href: 'https://www.madison.co.ke/careers' }).type).toBe('reject');
  });

  it('never reports Cyber security solutions as a posting (Liquid)', () => {
    // becomes a careers_page crawl target at worst — never a reported job
    expect(classify({ text: 'Cyber security solutions', href: 'https://liquid.tech/careers' }).type).not.toBe('posting');
  });

  it('still accepts real cyber role with engineer noun', () => {
    expect(classify({ text: 'Cyber Security Engineer', href: '/careers/cyber-security-engineer' }).type).toBe('posting');
  });

  it('still accepts Group Life Underwriting Specialist (Liberty — real)', () => {
    expect(classify({ text: 'Group Life Underwriting Specialist', href: 'https://www.liberty.co.ke/careers' }).type).toBe('posting');
  });

  it('rejects Our Leaders governance page despite new leader noun', () => {
    expect(classify({ text: 'Our Leaders', href: 'https://bank.co.ke/about-us/our-leaders' }).type).toBe('reject');
  });

  // v1 classics that must still reject
  it('rejects Personal Loan (product, no role noun)', () => {
    expect(isJob({ text: 'Personal Loan', href: '/personal/loans' })).toBe(false);
  });

  it('rejects "Savings Account — Apply Now"', () => {
    expect(isJob({ text: 'Savings Account — Apply Now', href: '/save/account' })).toBe(false);
  });

  it('rejects "Learn more" even on a careers URL', () => {
    expect(isJob({ text: 'Learn more', href: 'https://bank.com/careers/jobs' })).toBe(false);
  });

  it('rejects "Trade Finance" (product, no role noun)', () => {
    expect(isJob({ text: 'Trade Finance', href: '/products/trade-finance' })).toBe(false);
  });
});

// ── Careers landing pages (must be 'careers_page', not 'reject' or 'posting') ─

describe('careers landing pages — must be careers_page', () => {
  it('classifies Career Opportunities (Gulf African) as careers_page', () => {
    expect(classify({
      text: 'Career Opportunities',
      href: 'https://gulfafricanbank.com/about-us/career-opportunities/',
    }).type).toBe('careers_page');
  });

  it('classifies Explore opportunities (Ecobank Oracle ATS root) as careers_page', () => {
    expect(classify({
      text: 'Explore opportunities',
      href: 'https://fa-emqf-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1004',
    }).type).toBe('careers_page');
  });

  it('classifies Explore programmes (Ecobank ATS) as careers_page', () => {
    expect(classify({
      text: 'Explore programmes',
      href: 'https://fa-emqf-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1010',
    }).type).toBe('careers_page');
  });

  it('classifies Work With Us (Habib Bank) as careers_page', () => {
    expect(classify({
      text: 'Work With Us',
      href: 'https://habibbank.com/careers/',
    }).type).toBe('careers_page');
  });

  it('classifies Join Early Careers Network as careers_page', () => {
    expect(classify({
      text: 'Join Early Careers Network',
      href: 'https://citi.eightfold.ai/careers/join?jtn_form_id=jtn-early-career',
    }).type).toBe('careers_page');
  });
});

// ── Tender classifier ─────────────────────────────────────────────────────────
import { classifyTender } from './classifier';

describe('tender classifier', () => {
  it('accepts a supply tender with reference number', () => {
    const r = classifyTender({
      text: 'Tender No. KPLC/9A.1/PT/2/24 — Supply and Delivery of Transformers',
      href: 'https://www.kplc.co.ke/tenders/kplc-9a-1-pt-2-24.pdf',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts Provision of Consultancy Services with tender URL', () => {
    const r = classifyTender({
      text: 'Provision of Consultancy Services for Road Design',
      href: 'https://kenha.co.ke/tenders/provision-consultancy-services',
    });
    expect(r.type).toBe('posting');
  });

  it('accepts EOI / prequalification notice', () => {
    const r = classifyTender({
      text: 'Expression of Interest: Prequalification of Suppliers 2026',
      href: 'https://www.treasury.go.ke/tenders/eoi-2026.pdf',
    });
    expect(r.type).toBe('posting');
  });

  it('rejects tender award / results', () => {
    expect(classifyTender({ text: 'Tender Award Notice — Contract awarded to XYZ Ltd', href: '/tenders/award' }).type).toBe('reject');
  });

  it('classifies a Current Tenders landing page as crawl target', () => {
    expect(classifyTender({ text: 'Current Tenders', href: 'https://kra.go.ke/tenders' }).type).toBe('careers_page');
  });

  it('rejects generic nav on a tender site', () => {
    expect(classifyTender({ text: 'Contact Us', href: 'https://tenders.go.ke/contact' }).type).toBe('reject');
  });

  it('does not treat a job posting as a tender', () => {
    expect(classifyTender({ text: 'Senior Credit Analyst', href: '/careers/analyst' }).type).toBe('reject');
  });
});
