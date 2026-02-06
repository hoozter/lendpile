/********************************************************
 * 0. SUPABASE & AUTH/SYNC SERVICES
 ********************************************************/
const SUPABASE_URL = window.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Lendpile: Missing config. Copy config.example.js to config.js and add your Supabase URL and anon key.");
}
const supabaseClient = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/** Escape user-controlled text for safe use in HTML (prevents XSS when interpolating into innerHTML). */
function escapeHtml(str) {
  if (str == null) return '';
  const s = String(str);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Auth and user profile (display name, recovery email, MFA) */
const AuthService = {
  async signIn(email, password) {
    if (!supabaseClient) return { success: false, error: "Supabase not configured. Copy config.example.js to config.js." };
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  },
  async signUp(email, password, displayName, emailRedirectTo) {
    if (!supabaseClient) return { success: false, error: "Supabase not configured. Copy config.example.js to config.js." };
    const payload = { email, password };
    if (displayName && displayName.trim()) payload.data = { display_name: displayName.trim() };
    if (emailRedirectTo) payload.options = { emailRedirectTo };
    const { data, error } = await supabaseClient.auth.signUp(payload);
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  },
  async signOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
  },
  async getUser() {
    if (!supabaseClient) return null;
    const { data: { user } } = await supabaseClient.auth.getUser();
    return user;
  },
  async updateUser(updates) {
    if (!supabaseClient) return { success: false, error: "Supabase not configured." };
    const { data, error } = await supabaseClient.auth.updateUser(updates);
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  },
  async getAuthenticatorAssuranceLevel() {
    if (!supabaseClient) return { currentLevel: 'aal1', nextLevel: 'aal1' };
    const { data, error } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return { currentLevel: 'aal1', nextLevel: 'aal1' };
    return data || { currentLevel: 'aal1', nextLevel: 'aal1' };
  },
  async mfaListFactors() {
    if (!supabaseClient) return { data: { totp: [] }, error: { message: 'Not configured' } };
    return await supabaseClient.auth.mfa.listFactors();
  },
  async mfaEnroll() {
    if (!supabaseClient) return { data: null, error: { message: 'Not configured' } };
    return await supabaseClient.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Lendpile'
    });
  },
  async mfaChallenge(factorId) {
    if (!supabaseClient) return { data: null, error: { message: 'Not configured' } };
    return await supabaseClient.auth.mfa.challenge({ factorId });
  },
  async mfaVerify({ factorId, challengeId, code }) {
    if (!supabaseClient) return { data: null, error: { message: 'Not configured' } };
    return await supabaseClient.auth.mfa.verify({ factorId, challengeId, code });
  },
  async mfaUnenroll(factorId) {
    if (!supabaseClient) return { error: { message: 'Not configured' } };
    return await supabaseClient.auth.mfa.unenroll({ factorId });
  },
  onAuthStateChanged(callback) {
    if (supabaseClient) supabaseClient.auth.onAuthStateChange((event, session) => callback(event, session));
  }
};

const SyncService = {
  async syncData() {
    if (!supabaseClient) return;
    try {
      const user = await AuthService.getUser();
      if (!user) return;
      const loanData = StorageService.load("loanData");
      const { error } = await supabaseClient.from('loan_data')
        .upsert({ user_id: user.id, data: loanData }, { onConflict: 'user_id' });
      if (error) console.error('Sync error:', error);
    } catch (e) {
      console.error('Sync failed:', e);
    }
  },
  async loadData() {
    if (!supabaseClient) return [];
    try {
      const user = await AuthService.getUser();
      if (!user) return [];
      const { data, error } = await supabaseClient.from('loan_data')
        .select('data').eq('user_id', user.id).single();
      if (error) {
        console.error('Load error:', error);
        return [];
      }
      return data && data.data != null ? data.data : [];
    } catch (e) {
      console.error('Load failed:', e);
      return [];
    }
  }
};

/** Create and redeem share links; update shared loan when recipient has edit permission */
const ShareService = {
  async createShare(loan, options) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const user = await AuthService.getUser();
    if (!user) return { error: "You must be signed in to share a loan." };
    const token = crypto.randomUUID();
    const displayName = (user.user_metadata && user.user_metadata.display_name) || user.email || "";
    const expiresAt = new Date();
    const days = Math.max(1, parseInt(options.expiresInDays, 10) || 7);
    expiresAt.setDate(expiresAt.getDate() + days);
    const { error } = await supabaseClient.from("loan_shares").insert({
      token,
      owner_id: user.id,
      loan_id: loan.id,
      loan_snapshot: loan,
      permission: options.permission || "view",
      recipient_view: options.recipientView || "borrowing",
      owner_display_name: displayName,
      expires_at: expiresAt.toISOString()
    });
    if (error) return { error: error.message };
    const baseUrl = window.location.origin + window.location.pathname;
    return { shareUrl: `${baseUrl}?share=${token}` };
  },
  async redeemShare(token) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("redeem_share", { share_token: token });
    if (error) return { error: error.message };
    if (!data) return { error: "Link expired or invalid." };
    return { share: data };
  },
  async updateSharedLoan(token, loan) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("update_shared_loan", {
      share_token: token,
      loan_json: loan
    });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async listMyShares() {
    if (!supabaseClient) return { error: "Supabase not configured.", shares: [] };
    const user = await AuthService.getUser();
    if (!user) return { error: "Not signed in.", shares: [] };
    const { data, error } = await supabaseClient.from("loan_shares")
      .select("id, token, loan_id, loan_snapshot, permission, recipient_view, expires_at, used_at, recipient_id, recipient_email, recipient_display_name, transfer_requested_at, created_at, edit_requested_at, edit_requested_by")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false });
    if (error) return { error: error.message, shares: [] };
    return { shares: data || [] };
  },
  /** Shares where I am the recipient (used for "shared with me" list; one source of truth remains owner's data). */
  async listSharesReceived() {
    if (!supabaseClient) return { error: "Supabase not configured.", shares: [] };
    const user = await AuthService.getUser();
    if (!user) return { error: "Not signed in.", shares: [] };
    const { data, error } = await supabaseClient.from("loan_shares")
      .select("id, token, loan_id, loan_snapshot, permission, recipient_view, owner_display_name, expires_at, used_at, recipient_id, edit_requested_at, edit_request_resolved_at, edit_request_outcome, recipient_seen_resolution_at")
      .eq("recipient_id", user.id)
      .gt("expires_at", new Date().toISOString())
      .order("used_at", { ascending: false });
    if (error) return { error: error.message, shares: [] };
    return { shares: data || [] };
  },
  async revokeShare(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { error } = await supabaseClient.from("loan_shares").delete().eq("id", shareId);
    if (error) return { error: error.message };
    return { ok: true };
  },
  /** Recipient revokes the share (same effect as owner revoke: share is deleted, link stops working). */
  async revokeShareAsRecipient(token) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { error } = await supabaseClient.from("loan_shares").delete().eq("token", token);
    if (error) return { error: error.message };
    return { ok: true };
  },
  async updateShare(shareId, updates) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const payload = {};
    if (updates.permission) payload.permission = updates.permission;
    if (updates.recipientView) payload.recipient_view = updates.recipientView;
    if (Object.keys(payload).length === 0) return { ok: true };
    const { error } = await supabaseClient.from("loan_shares").update(payload).eq("id", shareId);
    if (error) return { error: error.message };
    return { ok: true };
  },
  async requestEditAccess(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("request_edit_access", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async approveEditRequest(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("approve_edit_request", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async declineEditRequest(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("decline_edit_request", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async markEditResolutionSeen(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("mark_edit_resolution_seen", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async listTransferOffers() {
    if (!supabaseClient) return { error: "Supabase not configured.", offers: [] };
    const user = await AuthService.getUser();
    if (!user) return { offers: [] };
    const { data, error } = await supabaseClient.from("loan_shares")
      .select("id, loan_snapshot, owner_display_name, transfer_requested_at")
      .eq("recipient_id", user.id)
      .not("transfer_requested_at", "is", null);
    if (error) return { error: error.message, offers: [] };
    return { offers: data || [] };
  },
  async requestTransferToRecipient(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("request_transfer_to_recipient", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async acceptTransfer(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("accept_transfer", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async declineTransfer(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("decline_transfer", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  },
  async cancelTransferRequest(shareId) {
    if (!supabaseClient) return { error: "Supabase not configured." };
    const { data, error } = await supabaseClient.rpc("cancel_transfer_request", { share_id: shareId });
    if (error) return { error: error.message };
    return { ok: data === true };
  }
};

/********************************************************
 * 1. LANGUAGE SERVICE
 ********************************************************/
const LanguageService = {
  currentLanguage: navigator.language.toLowerCase().startsWith('sv') ? 'sv' : 'en',
  init() {
    const saved = localStorage.getItem("preferredLanguage");
    if (saved && this.translations[saved]) {
      this.currentLanguage = saved;
    }
    localStorage.setItem("preferredLanguage", this.currentLanguage);
    this.updateUI();
  },
  translations: {
    sv: {
      myLoans: 'Mina lån',
      totalMonthly: 'Total månadsbetalning',
      totalDebt: 'Total skuld',
      loan: 'lån',
      loans: 'lån',
      addLoan: 'Lägg till Lån',
      noLoans: 'Inga lån registrerade. Lägg till ett nytt lån ovan eller importera lån från en fil under inställningar.',
      editLoan: 'Redigera Lån',
      loanType: 'Lånetyp',
      loanTypeBorrow: 'Jag lånar',
      loanTypeLend: 'Jag lånar ut',
      owedToYou: 'Till dig',
      monthlyIncoming: 'Månadsinkomst',
      totalMonthlyIncoming: 'Total månadsinkomst',
      owedToYouTotal: 'Till dig totalt',
      showMonthlyIncoming: 'Månadsinkomst (lån ut)',
      showOwedToYou: 'Till dig (lån ut)',
      loanDetails: 'Låneuppgifter',
      loanName: 'Lånenamn',
      startDate: 'Startdatum',
      loanAmount: 'Lånebelopp',
      initialAmount: 'Ursprungligt lånebelopp',
      interestRate: 'Ränta (%)',
      currency: 'Valuta',
      interest: 'Ränta',
      interestChanges: 'Ränteförändringar',
      loanChanges: 'Låneförändringar',
      removeLoan: 'Ta bort Lån',
      unlockSensitiveFields: 'Lås upp känsliga fält',
      lockSensitiveFields: 'Lås känsliga fält',
      save: 'Spara',
      addInterestChange: 'Lägg till ränteförändring',
      addLoanChange: 'Lägg till låneförändring',
      ratePercentLabel: 'Ränta (%)',
      initialInterestRate: 'Initial ränta (%)',
      interestSectionHelpNewLoan: 'Lägg till fler rader när räntan ändras.',
      loanChangesSectionHelpNewLoan: 'Här kan du registrera uttag eller ändringar av lånebeloppet. Detta kan även anges senare.',
      placeholderLoanName: 'T.ex. Bolån',
      addAmortization: 'Lägg till Amortering',
      amortizationplan: 'Amorteringsplan',
      scheduledAmortization: 'Schemalagd Amortering',
      oneTimeAmortization: 'Engångsamortering',
      amount: 'Belopp',
      paymentDetails: 'Betalningsuppgifter',
      schedule: 'Schema',
      type: 'Typ',
      frequency: 'Frekvens',
      removeAmortization: 'Ta bort Amortering',
      month: 'månad',
      dayOfMonth: 'Dag',
      lastDayBeforeWeekend: 'Sista vardagen i månaden',
      repeatEvery: 'Upprepa var',
      everyWeek: 'vecka',
      everyWeeks: 'veckor',
      everyMonth: 'månad',
      everyMonths: 'månader',
      payOnDay: 'Betalning dag',
      ofMonth: 'i månaden',
      sameWeekdayAsStart: 'Samma veckodag som start (t.ex. tisdag)',
      occursOn: 'Inträffar dag',
      occursEveryWeekday: 'Inträffar varje',
      occursDayOfMonth: 'Inträffar dag',
      noAmortizations: 'Amorteringsplan saknas, klicka på "Lägg till Amortering" för att skapa en.',
      edit: 'Redigera',
      showAmortizations: 'Visa amorteringar',
      showChart: 'Visa graf',
      active: 'Aktiv',
      inactive: 'Inaktiv',
      forecast: 'Prognos',
      monthsRemaining: 'Återstående månader',
      totalInterest: 'Total ränta',
      completionDate: 'Slutdatum',
      totalAmountPaid: 'Totalt belopp att betala',
      currentStatus: 'Nuvarande status',
      remainingDebt: 'Kvarvarande skuld',
      currentRate: 'Nuvarande ränta',
      interestCost: 'Räntekostnad',
      accumulatedInterest: 'Ackumulerad ränta',
      accumulatedAmortization: 'Ackumulerad amortering',
      monthsLeft: 'Mån kvar',
      interestChangedTo: 'Ränta ändrad till',
      increase: 'Ökning',
      decrease: 'Minskning',
      with: 'med',
      currentMonth: 'Aktuell månad',
      paymentThisMonth: 'Betalning denna månad',
      incomingThisMonth: 'Inkomst denna månad',
      startsOn: 'Startar',
      today: 'Idag',
      delete: 'Ta bort',
      cancel: 'Avbryt',
      invalidAmount: 'Ogiltigt belopp',
      invalidStartDate: 'Ogiltigt startdatum',
      startDateBeforeLoan: 'Startdatum kan inte vara före lånets startdatum',
      interestChangeBeforeLoanStart: 'Ränteförändringens datum kan inte vara före lånets startdatum.',
      addAtLeastOneInterest: 'Lägg till minst en räntepost (datum och ränta) för lånet.',
      endDate: 'Slutdatum (valfritt)',
      endDateBeforeStart: 'Slutdatum kan inte vara före startdatum',
      loanSaved: 'Lån sparat',
      loanUpdated: 'Lån uppdaterat',
      loanRemoved: 'Lån borttaget',
      amortizationSaved: 'Amortering sparad',
      amortizationRemoved: 'Amortering borttagen',
      dataImported: 'Data importerad',
      importError: 'Fel vid import',
      settingsSaved: 'Inställningarna har sparats!',
      confirmDelete: 'Bekräfta Radering',
      deleteConfirmMessage: 'Är du säker på att du vill ta bort denna post?',
      warning: 'Varning - Känsligt Fält',
      unlockWarningMessage: 'Att ändra detta värde kan påverka:',
      historyCalc: 'Historiska beräkningar',
      futurePred: 'Framtida prognoser',
      amortPlans: 'Amorteringsplaner',
      confirmChange: 'Är du säker på att du vill göra denna ändring?',
      tempUnlock: 'Lås upp tillfälligt',
      settings: 'Inställningar',
      startPage: 'Startsida',
      startPageDescription: 'Välj vad som ska visas i översikten och vilka lån som ska ingå i summeringen.',
      showOnStartPage: 'Visa på startsidan',
      showTotalMonthly: 'Total månadsbetalning',
      showTotalDebt: 'Total skuld',
      showMonthlyIncoming: 'Månadsinkomst (lån ut)',
      showOwedToYou: 'Till dig (lån ut)',
      showLoanCount: 'Antal lån',
      includeInSummary: 'Ingå i summering',
      privacyAndLegal: 'Integritet och juridik',
      privacyPolicy: 'Integritet och disclaimer',
      securityPromptTitle: 'Säkra ditt konto',
      securityPromptBody: 'Lägg till tvåfaktorsautentisering (2FA) och en återställnings-e-post så att du alltid kan komma åt ditt konto. Du hittar båda under Konto.',
      securityPrompt2faTitle: 'Säkra ditt konto med 2FA',
      securityPrompt2faBody: 'Tvåfaktorsautentisering (2FA) skyddar ditt konto så att bara du kan logga in, även om någon får ditt lösenord. Du aktiverar det under Konto → Säkerhet.',
      securityPromptSetUpNow: 'Sätt upp nu',
      securityPromptMaybeLater: 'Kanske senare',
      securityPromptDontAskAgain: 'Fråga inte igen',
      helpAndFaq: 'Hjälp och vanliga frågor',
      sourceCode: 'Källkod (GitHub)',
      language: 'Språk',
      defaultCurrency: 'Standardvaluta',
      dataManagement: 'Datahantering',
      exportData: 'Exportera Data',
      exportLoans: 'Exportera lån',
      exportLoansHelp: 'Välj vilka lån som ska ingå i exporten.',
      selectAllLoans: 'Välj alla lån',
      exportSelectedLoans: 'Exportera valda lån',
      selectAtLeastOneLoan: 'Välj minst ett lån att exportera.',
      loansExported: 'Lån exporterade.',
      importData: 'Importera Data',
      importLoans: 'Importera lån',
      importLoansHelp: 'Välj en JSON-fil med lån (export från Lendpile eller array av lån).',
      selectFile: 'Välj Fil',
      tooltipLoanIncrease: 'Lån ökat med',
      tooltipLoanDecrease: 'Lån minskat med',
      tooltipInterestChange: 'Ränta ändrad till',
      noAmortizationPlan: 'Amorteringsplan saknas',
      importWarning: 'Varning: Överlappande lån',
      importWarningMessage: 'Följande lån kommer att skrivas över:',
      importChoice: 'Hur vill du fortsätta?',
      overwriteLoans: 'Skriv över befintliga',
      importAsNew: 'Importera som nya lån',
      willBeOverwritten: 'kommer att skrivas över av',
      overpaymentWarning: 'Sista betalningen är större än återstående skuld',
      finalPayment: 'Sista betalning',
      remainingDebtOnly: 'Kvarvarande skuld',
      date: 'Datum',
      rate: 'Ränta',
      actions: 'Åtgärder',
      paymentLabel: 'Betalning',
      monthlyPayment: 'Månadsbetalning',
      biMonthlyPayment: 'Varannan månad',
      triMonthlyPayment: 'Var tredje månad',
      everyMonthsPayment: 'Var {freq} månad',
      weeklyPayment: 'Veckobetalning',
      everyWeeksPayment: 'Var {freq} vecka',
      loginTitle: 'Logga in',
      loginSubtitle: 'Logga in för att synka dina lån mellan enheter.',
      email: 'E-post',
      password: 'Lösenord',
      login: 'Logga in',
      signUp: 'Skapa konto',
      or: 'eller',
      continueWithoutAccount: 'Fortsätt utan konto',
      signUpSuccess: 'Kontot skapat. Kontrollera din e-post för bekräftelse.',
      signUpSubtitle: 'Ange din e-post och välj ett lösenord för att spara och synka dina lån.',
      displayNameOptional: 'Visningsnamn (valfritt)',
      displayNameUsedForSharing: 'Visas när du delar lån med andra.',
      choosePassword: 'Välj ett lösenord',
      noAccountCreateOne: 'Har du inget konto? Skapa ett',
      haveAccountLogIn: 'Har du redan ett konto? Logga in',
      offlineBannerText: 'Du använder appen utan konto. Data sparas bara på denna enhet. Logga in eller skapa konto för att spara och synka.',
      signInOrCreateAccount: 'Logga in eller skapa konto',
      enterEmailAndPassword: 'Ange e-post och lösenord.',
      passwordMinLength: 'Lösenordet måste vara minst 6 tecken.',
      linkExpiredOrInvalid: 'Bekräftelselänken har gått ut eller är ogiltig. Logga in nedan eller skapa ett nytt konto.',
      emailVerifiedWelcome: 'Din e-post är verifierad. Välkommen!',
      signedInAs: 'Inloggad som',
      logOut: 'Logga ut',
      changePassword: 'Byt lösenord',
      currentPassword: 'Nuvarande lösenord',
      newPassword: 'Nytt lösenord',
      confirmPassword: 'Bekräfta nytt lösenord',
      passwordRequirements: 'Minst 8 tecken, stor och liten bokstav samt siffra eller specialtecken.',
      passwordUpdated: 'Lösenordet har uppdaterats.',
      passwordsDoNotMatch: 'Lösenorden matchar inte.',
      invalidPasswordStrength: 'Lösenordet uppfyller inte kraven (8+ tecken, stor/liten bokstav, siffra eller specialtecken).',
      currentPasswordIncorrect: 'Nuvarande lösenord är fel.',
      from: 'Från',
      upcomingRateFrom: 'Från',
      duplicate: 'Duplicera',
      shareLoan: 'Dela lån',
      shareLoanHelp: 'Skapa en tidsbegränsad, engångslänk. Mottagaren ser vem som delar och kan öppna lånet (endast visa eller redigera).',
      shareDisplayNameHint: 'Mottagaren ser ditt visningsnamn när de öppnar länken. Om du inte har angett ett visas din e-postadress i stället. Du kan ange visningsnamn under Konto.',
      shareEmailShownTitle: 'Visningsnamn inte angivet',
      shareEmailShownMessage: 'Din e-postadress visas för mottagaren. Lägg till ett visningsnamn under Konto så att de ser ditt namn i stället.',
      shareAddDisplayName: 'Lägg till visningsnamn',
      shareCreateLinkAnyway: 'Skapa länk ändå',
      sharePermission: 'Behörighet',
      shareViewOnly: 'Endast visa',
      shareCanEdit: 'Kan redigera',
      shareRecipientView: 'Mottagaren är:',
      shareBorrowing: 'Låntagare',
      shareLending: 'Långivare',
      shareExpires: 'Länken går ut',
      shareCreateLink: 'Skapa länk',
      shareLinkCreated: 'Länk skapad. Dela den endast med den du vill ska se lånet.',
      activeSharesForThisLoan: 'Aktiva länkar för detta lån',
      revokeShare: 'Återkalla',
      editRequestBanner: 'Redigeringsåtkomst begärd för {loanName} av {requester}.',
      editRequestApprovedBanner: 'Din begäran om redigeringsåtkomst för {name} godkändes.',
      editRequestDeclinedBanner: 'Din begäran om redigeringsåtkomst för {name} avslogs.',
      editRequestedByRecipient: 'Mottagaren har bett om redigeringsåtkomst.',
      editRequestApproved: 'Redigeringsåtkomst beviljad.',
      editRequestDeclined: 'Begäran avslagen.',
      approve: 'Godkänn',
      decline: 'Avböj',
      ok: 'OK',
      viewOnlyRequestEdit: 'Endast visa. Begär redigeringsåtkomst från {name}?',
      viewOnlyCantEdit: 'Endast visa. Begär redigeringsåtkomst för att göra ändringar.',
      requestEditAccess: 'Begär redigeringsåtkomst',
      requestAlreadySent: 'Begäran skickad. {name} kan bevilja åtkomst från delningsinställningarna.',
      transferToRecipient: 'Överför till mottagare',
      transferToRecipientConfirm: 'Skicka en överföringsförfrågan till mottagaren? De får ett erbjudande när de öppnar appen och kan acceptera eller avböja.',
      transferRequested: 'Överföring begärd. Mottagaren ser erbjudandet när de öppnar appen.',
      transferPending: 'Väntar på svar',
      cancelTransferRequest: 'Återkalla förfrågan',
      transferToRecipientDone: 'Lånet har överförts till mottagaren.',
      transferOfferTitle: 'vill överföra ett lån till dig',
      transferOfferBody: 'Om du accepterar läggs det till på ditt konto och de har det inte längre.',
      transferOfferAccept: 'Acceptera',
      transferOfferDecline: 'Avböj',
      transferReceived: 'Lån mottaget.',
      transferDeclined: 'Överföring avböjd.',
      changePermission: 'Ändra behörighet',
      shareExpiresOn: 'Går ut',
      sharedWith: 'Delad med',
      linkNotUsedYet: 'Länk ej använd än',
      signedInUser: 'Inloggad användare',
      shareExpired: 'utgången',
      copyLink: 'Kopiera länk',
      signInToViewShare: 'Logga in eller skapa ett konto för att öppna det delade lånet.',
      sharedLoanPreviewIntro: 'delade ett lån med dig.',
      sharedLoanPreviewTitleLabel: 'Låntitel:',
      sharedBy: 'Delad av {name}',
      sharedLoanBanner: '{name} delar detta lån med dig.',
      sharedLoanSaveChanges: 'Spara ändringar',
      sharedLinkExpired: 'Länken har gått ut eller är ogiltig.',
      newVersionAvailable: 'Ny version tillgänglig',
      newVersionAvailableMessage: 'Det finns en ny version av sidan. Tryck på Uppdatera för att ladda den.',
      updateToLoad: 'Uppdatera',
      sharedLinkUsedByOther: 'Denna länk har redan använts av någon annan.',
      someone: 'Någon',
      removeFromMyList: 'Ta bort från min lista',
      removeSharedLoanTitle: 'Ta bort delat lån från listan?',
      removeSharedLoanMessage: 'Länken återkallas. Du ser inte längre detta lån i din lista (på någon enhet) och länken fungerar inte längre. Lånet finns kvar i {owner}s konto.',
      sharedLoanRemovedFromList: 'Delningen är återkallad.',
      badgeBorrowing: 'Jag lånar',
      badgeLending: 'Jag lånar ut',
      duplicateLoan: 'Kopiera lån',
      copyOf: 'Kopia av {name}',
      loanDuplicated: 'Lån duplicerat',
      payOffByDate: 'Betala av senast',
      calculate: 'Beräkna',
      requiredMonthlyPayment: 'Månadsbetalning krävs',
      addAsPayment: 'Lägg till som amortering',
      targetDateInvalid: 'Kan inte betala av senast detta datum',
      extraPaymentTypeHelp: 'Engångs = en extra betalning en månad. Schemalagd = återkommande extra betalning.',
      overview: 'Översikt',
      amortizationsTab: 'Amorteringar',
      openLoan: 'Öppna',
      backToLoans: 'Tillbaka till lån',
      amortizationSchedule: 'Amorteringsschema',
      paymentPlans: 'Betalningsplaner',
      targetCompletionDate: 'Måldatum för avbetalning',
      amortizationOverTime: 'Amortering över tid',
      add: 'Lägg till',
      account: 'Konto',
      admin: 'Admin',
      loginEmail: 'Inloggnings‑e‑post',
      changeEmail: 'Ändra e‑post',
      sendVerification: 'Skicka verifiering',
      emailChangeSent: 'Verifieringslänk skickad till den nya e‑posten. E‑posten uppdateras när du bekräftar.',
      setAsPrimary: 'Sätt som inloggning',
      setAsDefault: 'Sätt som standard',
      default: 'Standard',
      addAnotherEmail: 'Lägg till annan e‑post',
      security: 'Säkerhet',
      dataAndPrivacy: 'Data och konto',
      exportAllData: 'Exportera all data',
      dataExported: 'Data exporterad.',
      deleteAccount: 'Ta bort konto',
      deleteAccountWarning: 'All din data (lån, inställningar och konto) raderas permanent och kan inte återställas. Detta går inte att ångra.',
      deleteAccountConfirm: 'Skriv in ditt lösenord och skriv DELETE i rutan nedan för att bekräfta.',
      deleteAccountTypeDelete: 'Skriv DELETE för att bekräfta',
      deleteMyAccount: 'Ta bort mitt konto',
      deleteAccountUnavailable: 'Kontoradering är inte tillgänglig. Om du använder Supabase Edge Function eller egen backend, kontrollera att den är utplacerad och att URL:en stämmer. Annars kan du ta bort användaren i Supabase Dashboard → Authentication → Users.',
      setDefaultFirst: 'Sätt en annan e‑post som standard först.',
      displayName: 'Visningsnamn',
      displayNameHelp: 'Används t.ex. när du delar ett lån: "David delar ett lån".',
      recoveryEmail: 'Återställnings‑/reserve‑e‑post',
      recoveryEmailHelp: 'Valfri. Du kan sätta den som inloggnings‑e‑post efter att du sparat; en verifieringslänk skickas.',
      twoFactorAuth: 'Tvåfaktorsautentisering (2FA)',
      twoFactorHelp: 'Skanna QR‑koden med en autentiseringsapp (t.ex. Google Authenticator) för extra säkerhet.',
      enable2FA: 'Aktivera 2FA',
      disable2FA: 'Inaktivera 2FA',
      mfaEnrollSteps: 'Skanna QR‑koden med din autentiseringsapp och ange sedan den 6‑siffriga koden nedan.',
      cantScanQR: 'Kan du inte skanna? Ange denna nyckel manuellt i din app:',
      copySecret: 'Kopiera nyckel',
      copied: 'Kopierad',
      mfaChallengePrompt: 'Ange den 6‑siffriga koden från din autentiseringsapp.',
      verificationCode: 'Verifieringskod',
      verify: 'Verifiera'
    },
    en: {
      myLoans: 'My Loans',
      totalMonthly: 'Total monthly',
      totalDebt: 'Total debt',
      loan: 'loan',
      loans: 'loans',
      addLoan: 'Add Loan',
      noLoans: 'No loans registered. Add a new loan above or import loans from a file under settings.',
      editLoan: 'Edit Loan',
      loanType: 'Loan type',
      loanTypeBorrow: 'I am borrowing',
      loanTypeLend: 'I am lending',
      owedToYou: 'Owed to you',
      monthlyIncoming: 'Monthly incoming',
      totalMonthlyIncoming: 'Total monthly incoming',
      owedToYouTotal: 'Owed to you (total)',
      showMonthlyIncoming: 'Monthly incoming (lending)',
      showOwedToYou: 'Owed to you',
      loanDetails: 'Loan details',
      loanName: 'Loan Name',
      startDate: 'Start Date',
      loanAmount: 'Loan Amount',
      initialAmount: 'Initial Amount',
      interestRate: 'Interest Rate (%)',
      currency: 'Currency',
      interest: 'Interest',
      interestChanges: 'Interest Changes',
      loanChanges: 'Loan Changes',
      removeLoan: 'Remove Loan',
      unlockSensitiveFields: 'Unlock sensitive fields',
      lockSensitiveFields: 'Lock sensitive fields',
      save: 'Save',
      addInterestChange: 'Add Interest Change',
      addLoanChange: 'Add Loan Change',
      ratePercentLabel: 'Rate (%)',
      initialInterestRate: 'Initial interest rate (%)',
      interestSectionHelpNewLoan: 'Add more rows when your rate changes.',
      loanChangesSectionHelpNewLoan: 'Here you can record additional drawdowns or changes to the loan amount. This can also be set later.',
      placeholderLoanName: 'e.g. Mortgage',
      addAmortization: 'Add Amortization',
      amortizationplan: 'Amortization plan',
      scheduledAmortization: 'Scheduled Amortization',
      oneTimeAmortization: 'One-time Amortization',
      amount: 'Amount',
      paymentDetails: 'Payment details',
      schedule: 'Schedule',
      type: 'Type',
      frequency: 'Frequency',
      removeAmortization: 'Remove Amortization',
      month: 'month',
      dayOfMonth: 'Day',
      lastDayBeforeWeekend: 'Last weekday of the month',
      repeatEvery: 'Repeat every',
      everyWeek: 'week',
      everyWeeks: 'weeks',
      everyMonth: 'month',
      everyMonths: 'months',
      payOnDay: 'Pay on',
      ofMonth: 'of month',
      sameWeekdayAsStart: 'Same weekday as start (e.g. Tuesday)',
      occursOn: 'Occurs on day',
      occursEveryWeekday: 'Occurs every',
      occursDayOfMonth: 'Occurs on day',
      noAmortizations: 'No amortization plan set up, click "Add Amortization" to create one.',
      edit: 'Edit',
      showAmortizations: 'Show Amortizations',
      showChart: 'Show Chart',
      active: 'Active',
      inactive: 'Inactive',
      forecast: 'Forecast',
      monthsRemaining: 'Months Remaining',
      totalInterest: 'Total Interest',
      completionDate: 'Completion Date',
      totalAmountPaid: 'Total Amount to Pay',
      currentStatus: 'Current Status',
      remainingDebt: 'Remaining Debt',
      currentRate: 'Current Interest Rate',
      interestCost: 'Interest Cost',
      accumulatedInterest: 'Accumulated interest',
      accumulatedAmortization: 'Accumulated amortization',
      monthsLeft: 'Months left',
      interestChangedTo: 'Interest changed to',
      increase: 'Increase',
      decrease: 'Decrease',
      with: 'by',
      currentMonth: 'Current month',
      paymentThisMonth: 'Payment this month',
      incomingThisMonth: 'Incoming this month',
      startsOn: 'Starts',
      today: 'Today',
      delete: 'Delete',
      cancel: 'Cancel',
      invalidAmount: 'Invalid amount',
      invalidStartDate: 'Invalid start date',
      startDateBeforeLoan: 'Start date cannot be before the loan start date',
      interestChangeBeforeLoanStart: 'Interest change date cannot be before the loan start date.',
      addAtLeastOneInterest: 'Add at least one interest entry (date and rate) for the loan.',
      endDate: 'End date (optional)',
      endDateBeforeStart: 'End date cannot be before the start date',
      loanSaved: 'Loan saved',
      loanUpdated: 'Loan updated',
      loanRemoved: 'Loan removed',
      amortizationSaved: 'Amortization saved',
      amortizationRemoved: 'Amortization removed',
      dataImported: 'Data imported',
      importError: 'Import error',
      settingsSaved: 'Settings Saved',
      confirmDelete: 'Confirm Deletion',
      deleteConfirmMessage: 'Are you sure you want to delete this record?',
      warning: 'Warning - Sensitive Field',
      unlockWarningMessage: 'Changing this value can affect:',
      historyCalc: 'Historical calculations',
      futurePred: 'Future predictions',
      amortPlans: 'Amortization plans',
      confirmChange: 'Are you sure you want to make this change?',
      tempUnlock: 'Temporarily Unlock',
      settings: 'Settings',
      startPage: 'Start page',
      startPageDescription: 'Choose what to show in the overview and which loans to include in the summary.',
      showOnStartPage: 'Show on start page',
      showTotalMonthly: 'Total monthly payment',
      showTotalDebt: 'Total debt',
      showMonthlyIncoming: 'Monthly incoming (lending)',
      showOwedToYou: 'Owed to you',
      showLoanCount: 'Number of loans',
      includeInSummary: 'Include in summary',
      privacyAndLegal: 'Privacy & disclaimer',
      privacyPolicy: 'Privacy & disclaimer',
      securityPromptTitle: 'Secure your account',
      securityPromptBody: 'Add two-factor authentication (2FA) and a recovery email so you can always get back into your account. You can set both up in Account.',
      securityPrompt2faTitle: 'Secure your account with 2FA',
      securityPrompt2faBody: 'Two-factor authentication (2FA) protects your account so only you can sign in, even if someone gets your password. Turn it on in Account → Security.',
      securityPromptSetUpNow: 'Set up now',
      securityPromptMaybeLater: 'Maybe later',
      securityPromptDontAskAgain: "Don't ask again",
      helpAndFaq: 'Help & FAQ',
      sourceCode: 'Source code (GitHub)',
      language: 'Language',
      defaultCurrency: 'Default Currency',
      dataManagement: 'Data Management',
      exportData: 'Export Data',
      exportLoans: 'Export loans',
      exportLoansHelp: 'Choose which loans to include in the export.',
      selectAllLoans: 'Select all loans',
      exportSelectedLoans: 'Export selected loans',
      selectAtLeastOneLoan: 'Select at least one loan to export.',
      loansExported: 'Loans exported.',
      importData: 'Import Data',
      importLoans: 'Import loans',
      importLoansHelp: 'Choose a JSON file with loans (Lendpile export or array of loans).',
      selectFile: 'Select File',
      tooltipLoanIncrease: 'Loan increased by',
      tooltipLoanDecrease: 'Loan decreased by',
      tooltipInterestChange: 'Interest changed to',
      noAmortizationPlan: 'No amortization plan set up',
      importWarning: 'Warning: Overlapping Loans',
      importWarningMessage: 'The following loans will be overwritten:',
      importChoice: 'How would you like to proceed?',
      overwriteLoans: 'Overwrite Existing',
      importAsNew: 'Import as New Loans',
      willBeOverwritten: 'will be overwritten by',
      overpaymentWarning: 'Final payment is larger than remaining debt',
      finalPayment: 'Final Payment',
      remainingDebtOnly: 'Remaining Debt',
      date: 'Date',
      rate: 'Rate',
      actions: 'Actions',
      paymentLabel: 'Payment',
      monthlyPayment: 'Monthly Payment',
      biMonthlyPayment: 'Bi‑monthly Payment',
      triMonthlyPayment: 'Tri‑monthly Payment',
      everyMonthsPayment: 'Every {freq} Months',
      weeklyPayment: 'Weekly payment',
      everyWeeksPayment: 'Every {freq} weeks',
      loginTitle: 'Log in',
      loginSubtitle: 'Sign in to sync your loans across devices.',
      email: 'Email',
      password: 'Password',
      login: 'Log in',
      signUp: 'Create account',
      or: 'or',
      continueWithoutAccount: 'Continue without an account',
      signUpSuccess: 'Account created. Check your email to confirm.',
      signUpSubtitle: 'Enter your email and choose a password to save and sync your loans.',
      displayNameOptional: 'Display name (optional)',
      displayNameUsedForSharing: 'Shown when you share loans with others.',
      choosePassword: 'Choose a password',
      noAccountCreateOne: "Don't have an account? Create one",
      haveAccountLogIn: 'Already have an account? Log in',
      offlineBannerText: "You're working without an account. Data is stored only on this device. Sign in or create an account to save your progress and sync across devices.",
      signInOrCreateAccount: 'Sign in or create account',
      enterEmailAndPassword: 'Please enter email and password.',
      passwordMinLength: 'Password must be at least 6 characters.',
      linkExpiredOrInvalid: 'Confirmation link expired or invalid. Sign in below or create a new account.',
      emailVerifiedWelcome: 'Your email is verified. Welcome!',
      signedInAs: 'Signed in as',
      logOut: 'Log out',
      changePassword: 'Change password',
      currentPassword: 'Current password',
      newPassword: 'New password',
      confirmPassword: 'Confirm new password',
      passwordRequirements: 'At least 8 characters, upper and lower case, and a number or special character.',
      passwordUpdated: 'Password updated.',
      passwordsDoNotMatch: 'Passwords do not match.',
      invalidPasswordStrength: 'Password does not meet requirements (8+ characters, upper/lower case, number or special character).',
      currentPasswordIncorrect: 'Current password is incorrect.',
      from: 'From',
      upcomingRateFrom: 'From',
      duplicate: 'Duplicate',
      shareLoan: 'Share loan',
      shareLoanHelp: 'Create a time-limited, one-time link. The recipient will see who is sharing and can open the loan (view only or can edit).',
      shareDisplayNameHint: 'Recipients will see your display name when they open the link. If you haven\'t set one, your email address will be shown instead. You can set a display name in Account.',
      shareEmailShownTitle: 'Display name not set',
      shareEmailShownMessage: 'Your email address will be shown to the recipient. Add a display name in Account so they see your name instead.',
      shareAddDisplayName: 'Add display name',
      shareCreateLinkAnyway: 'Create link anyway',
      sharePermission: 'Permission',
      shareViewOnly: 'View only',
      shareCanEdit: 'Can edit',
      shareRecipientView: 'The recipient is:',
      shareBorrowing: 'Borrower',
      shareLending: 'Lender',
      shareExpires: 'Link expires in',
      shareCreateLink: 'Create link',
      shareLinkCreated: 'Link created. Share it only with the person who should see the loan.',
      activeSharesForThisLoan: 'Active links for this loan',
      revokeShare: 'Revoke',
      editRequestBanner: 'Edit access requested for {loanName} by {requester}.',
      editRequestApprovedBanner: 'Your edit access request for {name} was approved.',
      editRequestDeclinedBanner: 'Your edit access request for {name} was declined.',
      editRequestedByRecipient: 'Recipient requested edit access.',
      editRequestApproved: 'Edit access granted.',
      editRequestDeclined: 'Request declined.',
      approve: 'Approve',
      decline: 'Decline',
      ok: 'OK',
      viewOnlyRequestEdit: 'View-only. Request edit access from {name}?',
      viewOnlyCantEdit: 'View-only. Request edit access to make changes.',
      requestEditAccess: 'Request edit access',
      requestAlreadySent: 'Request sent. {name} can grant access from share settings.',
      transferToRecipient: 'Transfer to recipient',
      transferToRecipientConfirm: 'Send a transfer request to the recipient? They will see an offer when they open the app and can accept or decline.',
      transferRequested: 'Transfer requested. The recipient will see the offer when they open the app.',
      transferPending: 'Pending response',
      cancelTransferRequest: 'Cancel request',
      transferToRecipientDone: 'Loan transferred to the recipient.',
      transferOfferTitle: 'wants to transfer a loan to you',
      transferOfferBody: 'If you accept, it will be added to your account and they will no longer have it.',
      transferOfferAccept: 'Accept',
      transferOfferDecline: 'Decline',
      transferReceived: 'Loan received.',
      transferDeclined: 'Transfer declined.',
      changePermission: 'Change permission',
      shareExpiresOn: 'Expires',
          sharedWith: 'Shared with',
          linkNotUsedYet: 'Link not used yet',
          signedInUser: 'Signed-in user',
      shareExpired: 'expired',
      copyLink: 'Copy link',
      signInToViewShare: 'Sign in or create an account to open this shared loan.',
      sharedLoanPreviewIntro: 'shared a loan with you.',
      sharedLoanPreviewTitleLabel: 'Loan title:',
      sharedBy: 'Shared by {name}',
      sharedLoanBanner: '{name} shared this loan with you.',
      sharedLoanSaveChanges: 'Save changes',
      sharedLinkExpired: 'This link has expired or is invalid.',
      newVersionAvailable: 'New version available',
      newVersionAvailableMessage: 'There is a new version of this page available. Press Update to load it.',
      updateToLoad: 'Update',
      sharedLinkUsedByOther: 'This link has already been used by someone else.',
      someone: 'Someone',
      removeFromMyList: 'Remove from my list',
      removeSharedLoanTitle: 'Remove shared loan from your list?',
      removeSharedLoanMessage: 'The share will be revoked. You will no longer see this loan in your list (on any device) and the link will stop working. The loan will remain in {owner}\'s account.',
      sharedLoanRemovedFromList: 'Share revoked.',
      badgeBorrowing: 'Borrowing',
      badgeLending: 'Lending',
      duplicateLoan: 'Duplicate loan',
      copyOf: 'Copy of {name}',
      loanDuplicated: 'Loan duplicated',
      payOffByDate: 'Pay off by date',
      calculate: 'Calculate',
      requiredMonthlyPayment: 'Required monthly payment',
      addAsPayment: 'Add as payment',
      targetDateInvalid: 'Cannot pay off by this date',
      extraPaymentTypeHelp: 'One-time = single extra payment in one month. Scheduled = recurring extra payment.',
      overview: 'Overview',
      amortizationsTab: 'Amortizations',
      openLoan: 'Open',
      backToLoans: 'Back to loans',
      amortizationSchedule: 'Amortization schedule',
      paymentPlans: 'Payment plans',
      targetCompletionDate: 'Target completion date',
      amortizationOverTime: 'Amortization over time',
      add: 'Add',
      account: 'Account',
      admin: 'Admin',
      setAsDefault: 'Set as default',
      default: 'Default',
      addAnotherEmail: 'Add another email',
      security: 'Security',
      dataAndPrivacy: 'Data and account',
      exportAllData: 'Export all data',
      dataExported: 'Data exported.',
      deleteAccount: 'Delete account',
      deleteAccountWarning: 'All your data (loans, settings, and account) will be permanently deleted and cannot be recovered. This cannot be undone.',
      deleteAccountConfirm: 'Enter your password and type DELETE in the box below to confirm.',
      deleteAccountTypeDelete: 'Type DELETE to confirm',
      deleteMyAccount: 'Delete my account',
      deleteAccountUnavailable: 'Account deletion is unavailable. If you use the Supabase Edge Function or a custom backend, ensure it is deployed and the URL is correct. Otherwise delete the user in Supabase Dashboard → Authentication → Users.',
      setDefaultFirst: 'Set another email as default first.',
      displayName: 'Display name',
      displayNameHelp: 'Shown when you share a loan, e.g. "David is sharing a loan".',
      recoveryEmail: 'Recovery / secondary email',
      recoveryEmailHelp: 'Optional email for recovery or notifications. Stored only in your profile.',
      twoFactorAuth: 'Two-factor authentication (2FA)',
      twoFactorHelp: 'Scan the QR code with an authenticator app (e.g. Google Authenticator) for extra security.',
      enable2FA: 'Enable 2FA',
      disable2FA: 'Disable 2FA',
      mfaEnrollSteps: 'Scan the QR code with your authenticator app, then enter the 6‑digit code below.',
      cantScanQR: "Can't scan? Enter this key manually in your app:",
      copySecret: 'Copy key',
      copied: 'Copied',
      mfaChallengePrompt: 'Enter the 6‑digit code from your authenticator app.',
      verificationCode: 'Verification code',
      verify: 'Verify'
    }
  },
  init() {
    const saved = localStorage.getItem("preferredLanguage");
    if (saved && this.translations[saved]) {
      this.currentLanguage = saved;
    }
    this.updateUI();
  },
  updateUI() {
    document.querySelectorAll("[data-translate]").forEach(el => {
      const key = el.getAttribute("data-translate");
      el.textContent = this.translate(key);
    });
  },
  translate(key) {
    return this.translations[this.currentLanguage][key] || key;
  },
  setLanguage(lang) {
    if (this.translations[lang]) {
      this.currentLanguage = lang;
      localStorage.setItem("preferredLanguage", lang);
      this.updateUI();
    }
  }
};

/********************************************************
 * 2. STORAGE SERVICE
 ********************************************************/
const StorageService = {
  save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error("Error saving data:", e);
      return false;
    }
  },
  load(key) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error("Error loading data:", e);
      return [];
    }
  }
};

async function updateUserHeader() {
  const block = document.getElementById("user-header-block");
  const emailEl = document.getElementById("profile-dropdown-email");
  const adminLink = document.getElementById("profile-admin");
  if (!block || !emailEl) return;
  const user = await AuthService.getUser();
  if (user && user.email) {
    block.classList.add("visible");
    const displayName = (user.user_metadata && user.user_metadata.display_name) ? String(user.user_metadata.display_name).trim() : '';
    emailEl.textContent = displayName || user.email;
    document.getElementById("profile-dropdown").classList.remove("open");
    if (adminLink) {
      const isAdmin = user.app_metadata && user.app_metadata.role === "admin";
      adminLink.style.display = isAdmin ? "" : "none";
    }
    const offlineBanner = document.getElementById("offline-banner");
    if (offlineBanner) offlineBanner.classList.add("hidden");
  } else {
    block.classList.remove("visible");
    if (adminLink) adminLink.style.display = "none";
  }
}

async function updateOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  const textEl = document.getElementById("offline-banner-text");
  const btn = document.getElementById("offline-banner-signin-btn");
  if (!banner || !textEl || !btn) return;
  const user = await AuthService.getUser();
  if (user && user.email) {
    banner.classList.add("hidden");
    return;
  }
  if (localStorage.getItem("offlineMode")) {
    banner.classList.remove("hidden");
    textEl.textContent = LanguageService.translate("offlineBannerText") || "You're working without an account. Sign in or create an account to save and sync.";
    btn.textContent = LanguageService.translate("signInOrCreateAccount") || "Sign in or create account";
  } else {
    banner.classList.add("hidden");
  }
}

function updateLoginPaneShareContext() {
  const shareLanding = document.getElementById("login-share-landing");
  const continueWrap = document.getElementById("login-continue-without-wrap");
  if (!continueWrap) return;
  const hasPendingShare = !!window._pendingShareToken;
  const shareLandingVisible = shareLanding && !shareLanding.classList.contains("hidden");
  if (hasPendingShare && shareLandingVisible) {
    continueWrap.classList.add("hidden");
  } else {
    continueWrap.classList.remove("hidden");
  }
}
function showLoginPane() {
  document.getElementById("login-pane").classList.remove("hidden");
  document.getElementById("signup-pane").classList.add("hidden");
  document.getElementById("login-feedback").textContent = "";
  document.getElementById("login-feedback").className = "";
  updateLoginPaneShareContext();
}
function showSignupPane() {
  document.getElementById("signup-pane").classList.remove("hidden");
  document.getElementById("login-pane").classList.add("hidden");
  document.getElementById("login-feedback").textContent = "";
  document.getElementById("login-feedback").className = "";
}

/** Build email list for Account: primary first (with Default), then secondary. */
function renderAccountEmailList(user) {
  const listEl = document.getElementById("account-email-list");
  if (!listEl) return;
  const primary = (user.email || "").trim();
  const recovery = (user.user_metadata && user.user_metadata.recovery_email) ? String(user.user_metadata.recovery_email).trim() : "";
  const emails = [];
  if (primary) emails.push({ email: primary, isDefault: true });
  if (recovery && recovery.toLowerCase() !== primary.toLowerCase()) emails.push({ email: recovery, isDefault: false });
  const defaultLabel = escapeHtml(LanguageService.translate("default"));
  const changeLabel = escapeHtml(LanguageService.translate("changeEmail"));
  const setDefaultLabel = escapeHtml(LanguageService.translate("setAsDefault"));
  const deleteLabel = escapeHtml(LanguageService.translate("delete"));
  const setDefaultFirstTitle = escapeHtml(LanguageService.translate("setDefaultFirst"));
  listEl.innerHTML = emails.map(({ email, isDefault }) => {
    const safeEmail = escapeHtml(email);
    const canDelete = !isDefault;
    const canSetDefault = !isDefault;
    return `<div class="account-email-item-wrap" data-email="${escapeHtml(email)}" data-is-default="${isDefault}">
      <div class="account-email-item">
        <span class="account-email-address">${safeEmail}</span>
        ${isDefault ? `<span class="account-email-default-badge">${defaultLabel}</span>` : ""}
        <button type="button" class="account-email-menu-btn" aria-haspopup="true" aria-expanded="false" title="Menu">⋮</button>
        <div class="account-email-menu" role="menu">
          <button type="button" role="menuitem" data-action="change">${changeLabel}</button>
          <button type="button" role="menuitem" data-action="setDefault" ${!canSetDefault ? "disabled" : ""}>${setDefaultLabel}</button>
          <button type="button" role="menuitem" data-action="delete" ${!canDelete ? `disabled title="${setDefaultFirstTitle}"` : ""}>${deleteLabel}</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

/** Populate Account section when user is signed in */
async function populateAccountSettings() {
  const section = document.getElementById("account-settings-section");
  if (!section) return;
  const user = await AuthService.getUser();
  if (!user || !user.email) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";
  renderAccountEmailList(user);
  const addLink = document.getElementById("account-add-email-link");
  const addWrap = document.getElementById("account-email-add-wrap");
  const recovery = (user.user_metadata && user.user_metadata.recovery_email) ? String(user.user_metadata.recovery_email).trim() : "";
  if (addLink) addLink.style.display = !recovery ? "" : "none";
  if (addWrap) addWrap.style.display = "none";
  const changeInline = document.getElementById("account-change-email-inline");
  if (changeInline) changeInline.style.display = "none";
  const emailFeedback = document.getElementById("account-email-change-feedback");
  if (emailFeedback) { emailFeedback.style.display = "none"; emailFeedback.textContent = ""; }
  const displayNameInput = document.getElementById("account-display-name");
  if (displayNameInput) {
    const dn = (user.user_metadata && user.user_metadata.display_name) ? String(user.user_metadata.display_name).trim() : '';
    displayNameInput.value = dn;
  }
  const mfaEnableBtn = document.getElementById("account-mfa-enable");
  const mfaDisableBtn = document.getElementById("account-mfa-disable");
  const factors = await AuthService.mfaListFactors();
  const hasTotp = factors.data && factors.data.totp && factors.data.totp.length > 0;
  if (mfaEnableBtn) mfaEnableBtn.style.display = hasTotp ? "none" : "";
  if (mfaDisableBtn) mfaDisableBtn.style.display = hasTotp ? "" : "none";
}

/** Strong password: min 8 chars, at least one upper, one lower, one number or special */
function isStrongPassword(p) {
  if (!p || p.length < 8) return false;
  if (!/[A-Z]/.test(p) || !/[a-z]/.test(p)) return false;
  if (!/[0-9]/.test(p) && !/[^A-Za-z0-9]/.test(p)) return false;
  return true;
}

/********************************************************
 * 3. CALCULATION SERVICE
 ********************************************************/
const CalculationService = {
  getMonthlyPaymentBreakdown(loan, d) {
    let breakdown = {};
    const currentDate = new Date(d.getFullYear(), d.getMonth(), 1);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    // Sort payments: one-time payments come first, then scheduled by start date.
    const payments = (loan.payments || []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === "one-time" ? -1 : 1;
      return new Date(a.startDate) - new Date(b.startDate);
    });
    for (const p of payments) {
      let ps = new Date(p.startDate);
      ps.setHours(0, 0, 0, 0);
      if (p.type === "one-time") {
        if (ps.getFullYear() === d.getFullYear() && ps.getMonth() === d.getMonth()) {
          const key = LanguageService.translate("oneTimeAmortization");
          breakdown[key] = (breakdown[key] || 0) + p.amount;
        }
      } else {
        if (ps > nextMonth) continue;
        if (p.endDate) {
          let pe = new Date(p.endDate);
          pe.setHours(0, 0, 0, 0);
          if (currentDate > pe) continue;
        }
        const unit = p.frequencyUnit || "month";
        const freq = parseInt(p.frequency || "1", 10);

        if (unit === "week") {
          const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
          const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime() + 86400000 - 1;
          const paymentDates = getPaymentDates(p, loan.startDate);
          let count = 0;
          for (const t of paymentDates) {
            if (t >= monthStart && t <= monthEnd) count++;
          }
          if (count > 0) {
            const key = freq === 1
              ? LanguageService.translate("weeklyPayment")
              : LanguageService.translate("everyWeeksPayment").replace("{freq}", freq);
            breakdown[key] = (breakdown[key] || 0) + p.amount * count;
          }
          continue;
        }

        const monthsDiff = (d.getFullYear() - ps.getFullYear()) * 12 + (d.getMonth() - ps.getMonth());
        if (monthsDiff >= 0 && monthsDiff % freq === 0) {
          let key = "";
          if (freq === 1) key = LanguageService.translate("monthlyPayment");
          else if (freq === 2) key = LanguageService.translate("biMonthlyPayment");
          else if (freq === 3) key = LanguageService.translate("triMonthlyPayment");
          else key = LanguageService.translate("everyMonthsPayment").replace("{freq}", freq);
          breakdown[key] = (breakdown[key] || 0) + p.amount;
        }
      }
    }
    let total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
    return { total, breakdown };
  },
  buildTimeline(loan) {
    if (!loan.startDate) return [];
    const timeline = [];
    let start = new Date(loan.startDate);
    start.setHours(0, 0, 0, 0);
    const startMonth = new Date(start.getFullYear(), start.getMonth(), 1);
    const interestChanges = (loan.interestChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const loanChanges = (loan.loanChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    let icIndex = 0;
    let lcIndex = 0;
    let currentDebt = loan.initialAmount || 0;
    let currentRate = loan.interestRate || 0;
    /* Apply all interest changes dated before loan start so rate and index match timeline at start */
    while (icIndex < interestChanges.length) {
      const icDate = new Date(interestChanges[icIndex].date);
      const icMonth = new Date(icDate.getFullYear(), icDate.getMonth(), 1);
      if (icMonth >= startMonth) break;
      currentRate = parseFloat(interestChanges[icIndex].rate);
      icIndex++;
    }
    let currentDate = new Date(start);
    let monthsCount = 0;
    let pendingInterestChange = null;
    while (monthsCount < 600 && currentDebt > 0) {
      const changesThisMonth = [];
      if (pendingInterestChange !== null) {
        const prevRate = currentRate;
        currentRate = pendingInterestChange;
        pendingInterestChange = null;
        if (prevRate !== currentRate) changesThisMonth.push({ type: "interest", value: currentRate });
      }
      if (icIndex < interestChanges.length) {
        let icDate = new Date(interestChanges[icIndex].date);
        if (icDate.getFullYear() === currentDate.getFullYear() && icDate.getMonth() === currentDate.getMonth()) {
          const newRate = parseFloat(interestChanges[icIndex].rate);
          if (newRate === currentRate) {
            currentRate = newRate;
          } else {
            pendingInterestChange = newRate;
          }
          icIndex++;
        }
      }
      while (lcIndex < loanChanges.length) {
        let lcDate = new Date(loanChanges[lcIndex].date);
        if (lcDate.getFullYear() < currentDate.getFullYear() ||
            (lcDate.getFullYear() === currentDate.getFullYear() && lcDate.getMonth() <= currentDate.getMonth())) {
          currentDebt += parseFloat(loanChanges[lcIndex].amount);
          changesThisMonth.push({ type: "loan", value: parseFloat(loanChanges[lcIndex].amount) });
          lcIndex++;
        } else {
          break;
        }
      }
      const startingDebt = currentDebt;
      const monthRate = currentRate / 100 / 12;
      const interest = startingDebt * monthRate;
      const paymentInfo = CalculationService.getMonthlyPaymentBreakdown(loan, currentDate);
      const payment = paymentInfo.total;
      const principalPaid = Math.max(0, Math.min(payment - interest, currentDebt));
      const unpaidInterest = Math.max(0, interest - payment);
      currentDebt = Math.max(0, currentDebt - principalPaid + unpaidInterest);
      if (currentDebt === 0 && payment > (startingDebt + interest)) {
        paymentInfo.isOverpayment = true;
        paymentInfo.actualNeeded = startingDebt + interest;
        paymentInfo.plannedPayment = payment;
      }
      let paymentDate = new Date(currentDate);
      const activePayment = loan.payments.find(p => {
        let pStart = new Date(p.startDate); pStart.setHours(0,0,0,0);
        let pEnd = p.endDate ? new Date(p.endDate) : null;
        if (pEnd) pEnd.setHours(0,0,0,0);
        return pStart <= currentDate && (!pEnd || pEnd >= currentDate);
      });
      if (activePayment) {
        const y = currentDate.getFullYear(), m = currentDate.getMonth();
        if (activePayment.frequencyUnit === "week") {
          const monthStart = new Date(y, m, 1);
          const monthEnd = new Date(y, m + 1, 0);
          const allInMonth = getPaymentDates(activePayment, loan.startDate)
            .filter(t => { const d = new Date(t); return d >= monthStart && d <= monthEnd; });
          paymentDate = allInMonth.length ? new Date(allInMonth[0]) : new Date(y, m, 1);
        } else if (activePayment.lastWeekdayOfMonth) {
          paymentDate = new Date(getLastWeekdayOfMonth(y, m));
        } else {
          paymentDate = new Date(y, m, 1);
          const paymentDay = parseInt(activePayment.dayOfMonth) || new Date(activePayment.startDate).getDate();
          const lastDayOfMonth = new Date(y, m + 1, 0).getDate();
          paymentDate.setDate(Math.min(paymentDay, lastDayOfMonth));
        }
      }
      const displayPayment = (paymentInfo.isOverpayment && paymentInfo.actualNeeded != null)
        ? paymentInfo.actualNeeded
        : payment;
      timeline.push({
        date: new Date(currentDate),
        paymentDate: paymentDate,
        startingDebt,
        interestRate: currentRate,
        changes: changesThisMonth,
        interest,
        payment: displayPayment,
        paymentBreakdown: paymentInfo.breakdown,
        amortization: principalPaid,
        endingDebt: currentDebt,
        isOverpayment: paymentInfo?.isOverpayment || false,
        actualNeeded: paymentInfo?.actualNeeded || 0
      });
      currentDate.setMonth(currentDate.getMonth() + 1);
      monthsCount++;
    }
    return timeline;
  },
  /** Required monthly payment to pay off the loan by target date (single scheduled payment scenario). */
  calculatePaymentForTargetDate(loan, targetDateStr) {
    if (!loan?.startDate || !targetDateStr) return null;
    const start = new Date(loan.startDate);
    start.setHours(0, 0, 0, 0);
    const target = new Date(targetDateStr);
    target.setHours(0, 0, 0, 0);
    const targetMonth = new Date(target.getFullYear(), target.getMonth(), 1);
    const startMonth = new Date(start.getFullYear(), start.getMonth(), 1);
    if (targetMonth <= startMonth) return null;
    const dayOfMonth = String(start.getDate());
    let low = 0;
    let high = (loan.initialAmount || 0) * 2 + 500000;
    const tol = 1;
    for (let iter = 0; iter < 60; iter++) {
      const P = (low + high) / 2;
      const loanCopy = {
        ...loan,
        payments: [{ type: 'scheduled', amount: P, startDate: loan.startDate, endDate: targetDateStr, frequency: 1, dayOfMonth }]
      };
      const timeline = this.buildTimeline(loanCopy);
      if (!timeline.length) { low = P; continue; }
      const last = timeline[timeline.length - 1];
      const lastMonth = new Date(last.date.getFullYear(), last.date.getMonth(), 1);
      if (last.endingDebt > 0.01 || lastMonth > targetMonth) low = P;
      else high = P;
      if (high - low < tol) break;
    }
    return Math.ceil((low + high) / 2 * 100) / 100;
  }
};

/********************************************************
 * Helper functions for payment validation
 ********************************************************/
function getLastWeekdayOfMonth(year, month) {
  const last = new Date(year, month + 1, 0);
  const dow = last.getDay();
  if (dow === 0) last.setDate(last.getDate() - 2);
  else if (dow === 6) last.setDate(last.getDate() - 1);
  return last.getTime();
}
function getPaymentDates(payment, loanStartDate) {
  const dates = [];
  const unit = payment.frequencyUnit || "month";
  const freq = parseInt(payment.frequency || "1", 10);
  let start = new Date(payment.startDate);
  start.setHours(0, 0, 0, 0);
  const endDate = payment.endDate ? new Date(payment.endDate) : null;
  if (endDate) endDate.setHours(23, 59, 59, 999);

  if (unit === "week") {
    const stepDays = freq * 7;
    for (let i = 0; i < 600 * 7; i += stepDays) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      if (endDate && d > endDate) break;
      dates.push(d.getTime());
    }
    return dates;
  }

  if (payment.lastWeekdayOfMonth) {
    let y = start.getFullYear(), m = start.getMonth();
    const startMonth = start.getTime();
    for (let i = 0; i < 600; i++) {
      const t = getLastWeekdayOfMonth(y, m);
      if (t >= startMonth) {
        if (endDate && t > endDate.getTime()) break;
        dates.push(t);
      }
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return dates;
  }

  const dayOfMonth = parseInt(payment.dayOfMonth || start.getDate(), 10);
  for (let i = 0; i < 600; i += freq) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dayOfMonth, lastDay));
    d.setHours(0, 0, 0, 0);
    if (d >= start) {
      if (endDate && d > endDate) break;
      dates.push(d.getTime());
    }
  }
  return dates;
}
function hasOverlappingDates(dates1, dates2) {
  return dates1.some(t1 => dates2.includes(t1));
}
/** Validate scheduled payment dates do not overlap with other scheduled payments. When editing, pass excludePaymentIndex so the payment being edited is not compared against itself. */
function validateNewPayment(loan, newPayment, excludePaymentIndex = null) {
  const existingPayments = loan.payments || [];
  if (newPayment.type === "one-time") return { valid: true };
  const exclude = excludePaymentIndex != null && !isNaN(excludePaymentIndex) ? parseInt(excludePaymentIndex, 10) : null;
  for (let i = 0; i < existingPayments.length; i++) {
    if (exclude !== null && i === exclude) continue;
    const p = existingPayments[i];
    if (p.type === "one-time" || newPayment.type === "one-time") continue;
    const dates1 = getPaymentDates(p, loan.startDate);
    const dates2 = getPaymentDates(newPayment, loan.startDate);
    if (hasOverlappingDates(dates1, dates2)) {
      return { valid: false, warning: "Payment dates overlap with existing payments" };
    }
  }
  return { valid: true };
}

const START_PAGE_BLOBS_KEY = "lendpile_startPageBlobs";
const START_PAGE_EXCLUDED_KEY = "lendpile_startPageExcluded";
const defaultStartPageBlobs = () => ({ totalMonthly: true, totalDebt: true, monthlyIncoming: true, owedToYou: true, loanCount: true });
function getStartPageBlobs() {
  try {
    let raw = localStorage.getItem(START_PAGE_BLOBS_KEY);
    if (!raw && localStorage.getItem("loanlab_startPageBlobs")) {
      raw = localStorage.getItem("loanlab_startPageBlobs");
      if (raw) { localStorage.setItem(START_PAGE_BLOBS_KEY, raw); localStorage.removeItem("loanlab_startPageBlobs"); }
    }
    if (!raw) return defaultStartPageBlobs();
    const o = JSON.parse(raw);
    return { ...defaultStartPageBlobs(), ...o };
  } catch (_) { return defaultStartPageBlobs(); }
}
function getStartPageExcluded() {
  try {
    let raw = localStorage.getItem(START_PAGE_EXCLUDED_KEY);
    if (!raw && localStorage.getItem("loanlab_startPageExcluded")) {
      raw = localStorage.getItem("loanlab_startPageExcluded");
      if (raw) { localStorage.setItem(START_PAGE_EXCLUDED_KEY, raw); localStorage.removeItem("loanlab_startPageExcluded"); }
    }
    if (!raw) return [];
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch (_) { return []; }
}
function saveStartPageBlobs(blobs) {
  localStorage.setItem(START_PAGE_BLOBS_KEY, JSON.stringify(blobs));
}
function saveStartPageExcluded(names) {
  localStorage.setItem(START_PAGE_EXCLUDED_KEY, JSON.stringify(names));
}

/********************************************************
 * 4. UI HANDLER
 ********************************************************/
const UIHandler = {
  init() {
    this.restoreBodyScroll();
    this.initializeTheme();
    this.initializeEventListeners();
    this.renderLoans();
    this.checkTransferOffers();
    this.checkEditRequests();
    this.checkEditResolutionBanner();
  },
  initializeTheme() {
    const saved = localStorage.getItem("theme");
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const theme = saved || systemTheme;
    const isDark = theme === "dark";
    document.getElementById("theme-toggle").checked = isDark;
    document.getElementById("themeIconLight").classList.toggle("active", !isDark);
    document.getElementById("themeIconDark").classList.toggle("active", isDark);
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  },
  setTheme(isDark) {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    document.getElementById("theme-toggle").checked = isDark;
    document.getElementById("themeIconLight").classList.toggle("active", !isDark);
    document.getElementById("themeIconDark").classList.toggle("active", isDark);
  },
  initializeEventListeners() {
    document.getElementById("theme-toggle").addEventListener("change", e => {
      UIHandler.setTheme(e.target.checked);
    });
    document.getElementById("themeIconLight").addEventListener("click", () => UIHandler.setTheme(false));
    document.getElementById("themeIconDark").addEventListener("click", () => UIHandler.setTheme(true));
    document.getElementById("profile-settings").addEventListener("click", () => {
      const pd = document.getElementById("profile-dropdown");
      const pib = document.getElementById("profile-icon-btn");
      if (pd) pd.classList.remove("open");
      if (pib) pib.setAttribute("aria-expanded", "false");
      UIHandler.showModal("settings-modal");
      UIHandler.populateStartPageSettings();
      UIHandler.populateExportLoansList();
    });
    document.getElementById("profile-account").addEventListener("click", async () => {
      const pd = document.getElementById("profile-dropdown");
      const pib = document.getElementById("profile-icon-btn");
      if (pd) pd.classList.remove("open");
      if (pib) pib.setAttribute("aria-expanded", "false");
      UIHandler.showModal("account-modal");
      await populateAccountSettings();
    });
    const blobMonthly = document.getElementById("start-page-blob-monthly");
    const blobDebt = document.getElementById("start-page-blob-debt");
    const blobCount = document.getElementById("start-page-blob-count");
    if (blobMonthly) blobMonthly.addEventListener("change", () => {
      const blobs = getStartPageBlobs();
      blobs.totalMonthly = blobMonthly.checked;
      saveStartPageBlobs(blobs);
      if (UIHandler.currentDetailLoanIndex == null) UIHandler.renderLoans();
    });
    if (blobDebt) blobDebt.addEventListener("change", () => {
      const blobs = getStartPageBlobs();
      blobs.totalDebt = blobDebt.checked;
      saveStartPageBlobs(blobs);
      if (UIHandler.currentDetailLoanIndex == null) UIHandler.renderLoans();
    });
    if (blobCount) blobCount.addEventListener("change", () => {
      const blobs = getStartPageBlobs();
      blobs.loanCount = blobCount.checked;
      saveStartPageBlobs(blobs);
      if (UIHandler.currentDetailLoanIndex == null) UIHandler.renderLoans();
    });
    const blobMonthlyIncoming = document.getElementById("start-page-blob-monthly-incoming");
    const blobOwed = document.getElementById("start-page-blob-owed");
    if (blobMonthlyIncoming) blobMonthlyIncoming.addEventListener("change", () => {
      const blobs = getStartPageBlobs();
      blobs.monthlyIncoming = blobMonthlyIncoming.checked;
      saveStartPageBlobs(blobs);
      if (UIHandler.currentDetailLoanIndex == null) UIHandler.renderLoans();
    });
    if (blobOwed) blobOwed.addEventListener("change", () => {
      const blobs = getStartPageBlobs();
      blobs.owedToYou = blobOwed.checked;
      saveStartPageBlobs(blobs);
      if (UIHandler.currentDetailLoanIndex == null) UIHandler.renderLoans();
    });
    document.getElementById("settings-modal").addEventListener("change", e => {
      if (!e.target.classList.contains("start-page-include-checkbox")) return;
      const row = e.target.closest(".start-page-loan-row");
      if (!row) return;
      const loanName = row.getAttribute("data-loan-name");
      if (loanName == null) return;
      let excluded = getStartPageExcluded();
      if (e.target.checked) excluded = excluded.filter(n => n !== loanName);
      else if (!excluded.includes(loanName)) excluded.push(loanName);
      saveStartPageExcluded(excluded);
      if (UIHandler.currentDetailLoanIndex == null) UIHandler.renderLoans();
    });
    document.getElementById("add-loan-btn").addEventListener("click", () => {
      FormHandler.openLoanModal();
    });
    document.querySelectorAll(".loan-type-toggle [data-loan-type]").forEach(btn => {
      btn.addEventListener("click", function() {
        const type = this.getAttribute("data-loan-type");
        const form = document.getElementById("loan-form-modal");
        if (!form) return;
        form.querySelectorAll(".loan-type-toggle [data-loan-type]").forEach(b => b.classList.remove("active"));
        this.classList.add("active");
        const input = form.querySelector("#loanType");
        if (input) input.value = type;
      });
    });
    document.querySelectorAll(".btn-close").forEach(btn => {
      btn.addEventListener("click", ev => {
        const modal = ev.target.closest(".modal");
        if (!modal) return;
        if (modal.id === "delete-confirmation-modal") ConfirmHandler.cancelDelete();
        else if (modal.id === "remove-shared-loan-modal") UIHandler.cancelRemoveSharedLoan();
        else if (modal.id === "generic-confirm-modal") UIHandler.cancelGenericConfirm();
        else modal.style.display = "none";
      });
    });
    document.getElementById("cancel-change-btn").addEventListener("click", () => {
      UIHandler.closeModal("add-change-modal");
    });
    document.querySelectorAll(".modal-lock-control").forEach(control => {
      control.addEventListener("click", e => UIHandler.handleLockControlClick(e));
    });
    document.addEventListener("click", function viewOnlyFieldClick(ev) {
      const form = ev.target.closest?.("form[data-shared-view-only]");
      if (!form) return;
      if (ev.target.matches("input, select, textarea, button") && ev.target.disabled) {
        ev.preventDefault();
        UIHandler.showFeedback(LanguageService.translate("viewOnlyCantEdit") || "View-only. Request edit access to make changes.");
      }
    }, true);
    document.addEventListener("focusin", function viewOnlyFieldFocus(ev) {
      const form = ev.target.closest?.("form[data-shared-view-only]");
      if (!form) return;
      if (ev.target.matches("input, select, textarea") && ev.target.disabled) {
        UIHandler.showFeedback(LanguageService.translate("viewOnlyCantEdit") || "View-only. Request edit access to make changes.");
      }
    }, true);
    document.querySelectorAll(".modal").forEach(modal => {
      modal.addEventListener("click", function(e) {
        if (e.target !== modal) return;
        if (modal.id === "delete-confirmation-modal") {
          ConfirmHandler.cancelDelete();
        } else if (modal.id === "remove-shared-loan-modal") {
          UIHandler.cancelRemoveSharedLoan();
        } else if (modal.id === "generic-confirm-modal") {
          UIHandler.cancelGenericConfirm();
        } else if (modal.id === "login-modal") {
          modal.style.display = "none";
          UIHandler.restoreBodyScroll();
          showLoginPane();
        } else {
          modal.style.display = "none";
          UIHandler.restoreBodyScroll();
        }
      });
    });
  },
  handleLockControlClick(e) {
    const control = e.currentTarget;
    const form = control.closest(".modal")?.querySelector("form");
    if (form?.getAttribute("data-shared-view-only")) return;
    this._pendingLockControl = control;
    if (control.classList.contains("locked")) {
      UIHandler.showModal("unlock-confirmation-modal");
    } else {
      UIHandler.applyLockState(control, true);
    }
  },
  confirmUnlock() {
    UIHandler.closeModal("unlock-confirmation-modal");
    if (!this._pendingLockControl) return;
    UIHandler.applyLockState(this._pendingLockControl, false);
    this._pendingLockControl = null;
  },
  applyLockState(control, shouldLock) {
    const modal = control.closest(".modal");
    let fields = [];
    if (modal.id === "loan-modal") { fields = ["loanStartDate", "loanInitialAmount"]; }
    else if (modal.id === "amortization-modal") { fields = ["amortizationAmount", "amortizationStartDate"]; }
    UIHandler.setLockState(modal, fields, shouldLock);
  },
  setLockState(modal, fields, shouldLock) {
    const form = modal.querySelector("form");
    const isViewOnly = form?.getAttribute("data-shared-view-only");
    const lockControl = modal.querySelector(".modal-lock-control");
    fields.forEach(fid => {
      const el = document.getElementById(fid);
      if (!el) return;
      el.disabled = shouldLock;
      const container = el.closest("div");
      if (shouldLock) {
        container.classList.add("locked-field-container");
        container.classList.remove("unlocked-field-container");
      } else {
        container.classList.remove("locked-field-container");
        container.classList.add("unlocked-field-container");
      }
    });
    if (lockControl && !isViewOnly) {
      if (shouldLock) {
        lockControl.classList.add("locked");
        lockControl.classList.remove("unlocked");
        lockControl.querySelector(".material-icons").textContent = "lock";
        lockControl.querySelector(".lock-text").textContent = LanguageService.translate("unlockSensitiveFields");
      } else {
        lockControl.classList.remove("locked");
        lockControl.classList.add("unlocked");
        lockControl.querySelector(".material-icons").textContent = "lock_open";
        lockControl.querySelector(".lock-text").textContent = LanguageService.translate("lockSensitiveFields");
      }
    }
  },
  currentDetailLoanIndex: null,
  sharesReceived: [],
  getMergedLoansList() {
    const myLoans = StorageService.load("loanData") || [];
    const shared = (this.sharesReceived || []).map(s => ({
        ...(s.loan_snapshot || {}),
        loanType: (s.recipient_view || "borrowing") === "lending" ? "lend" : "borrow",
        _shared: { token: s.token, share: s }
      }));
    const merged = myLoans.map((loan, i) => ({ ...loan, _myIndex: i })).concat(shared);
    return merged.sort((a, b) => (a.loanType === "lend" ? 1 : 0) - (b.loanType === "lend" ? 1 : 0));
  },
  renderLoans() {
    if (this.currentShare) {
      this.renderDetailContent();
      return;
    }
    if (this.currentDetailLoanIndex != null) {
      this.renderDetailContent();
      return;
    }
    const loansList = document.getElementById("loans-list");
    const summaryEl = document.getElementById("list-summary");
    const merged = this.getMergedLoansList();
    if (!merged.length) {
      if (summaryEl) summaryEl.innerHTML = "";
      loansList.innerHTML = `<p>${LanguageService.translate("noLoans")}</p>`;
      return;
    }
    const excluded = getStartPageExcluded();
    const includedLoans = merged.filter(l => !excluded.includes(l.name));
    const blobs = getStartPageBlobs();
    const borrowLoans = includedLoans.filter(l => l.loanType !== "lend");
    const lendLoans = includedLoans.filter(l => l.loanType === "lend");
    const summaryBorrow = this.computeListSummary(borrowLoans);
    const summaryLend = this.computeListSummary(lendLoans);
    if (summaryEl) {
      const showAny = blobs.totalMonthly || blobs.totalDebt || blobs.monthlyIncoming || blobs.owedToYou || blobs.loanCount;
      if (!showAny || includedLoans.length === 0) {
        summaryEl.innerHTML = "";
      } else {
        const formatByCurrency = (summary, valueKey) => summary.map(({ currency, [valueKey]: value }) =>
          `<div class="list-summary-by-currency"><span class="list-summary-currency-label">${escapeHtml(currency)}</span><span class="list-summary-value">${UIHandler.formatCurrency(value, currency)}</span></div>`).join("");
        const cards = [];
        if (blobs.totalMonthly && summaryBorrow.length > 0) {
          cards.push(`<div class="list-summary-card"><span class="list-summary-title">${LanguageService.translate("totalMonthly")}</span><div class="list-summary-values">${formatByCurrency(summaryBorrow, "monthlyTotal")}</div></div>`);
        }
        if (blobs.totalDebt && summaryBorrow.length > 0) {
          cards.push(`<div class="list-summary-card"><span class="list-summary-title">${LanguageService.translate("totalDebt")}</span><div class="list-summary-values">${formatByCurrency(summaryBorrow, "debtTotal")}</div></div>`);
        }
        if (blobs.monthlyIncoming && summaryLend.length > 0) {
          cards.push(`<div class="list-summary-card"><span class="list-summary-title">${LanguageService.translate("totalMonthlyIncoming")}</span><div class="list-summary-values">${formatByCurrency(summaryLend, "monthlyTotal")}</div></div>`);
        }
        if (blobs.owedToYou && summaryLend.length > 0) {
          cards.push(`<div class="list-summary-card"><span class="list-summary-title">${LanguageService.translate("owedToYouTotal")}</span><div class="list-summary-values">${formatByCurrency(summaryLend, "debtTotal")}</div></div>`);
        }
        if (blobs.loanCount) {
          const totalCount = summaryBorrow.reduce((s, { count }) => s + count, 0) + summaryLend.reduce((s, { count }) => s + count, 0);
          const countLabel = totalCount === 1 ? LanguageService.translate("loan") : LanguageService.translate("loans");
          cards.push(`<div class="list-summary-card"><span class="list-summary-title">${LanguageService.translate("showLoanCount")}</span><span class="list-summary-value">${totalCount} ${countLabel}</span></div>`);
        }
        summaryEl.innerHTML = cards.join("");
      }
    }
    this._mergedLoansList = merged;
    loansList.innerHTML = merged.map((loan, i) => UIHandler.createLoanCardCompact(loan, i)).join("");
    this.bindCompactCardMenus();
  },
  computeListSummary(loans) {
    const byCurrency = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    loans.forEach(loan => {
      const timeline = CalculationService.buildTimeline(loan);
      const historical = timeline.filter(row => row.date < today);
      const currentRow = historical.length ? timeline[historical.length - 1] : (timeline[0] || null);
      const monthly = currentRow ? currentRow.payment : 0;
      const debt = currentRow ? currentRow.endingDebt : (loan.initialAmount + (loan.loanChanges || []).reduce((s, c) => s + c.amount, 0));
      const c = loan.currency || "SEK";
      if (!byCurrency[c]) byCurrency[c] = { monthlyTotal: 0, debtTotal: 0, count: 0 };
      byCurrency[c].monthlyTotal += monthly;
      byCurrency[c].debtTotal += debt;
      byCurrency[c].count += 1;
    });
    return Object.entries(byCurrency).map(([currency, data]) => ({ currency, ...data }));
  },
  createLoanCardCompact(loan, index) {
    const fullTimeline = CalculationService.buildTimeline(loan);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const forecast = fullTimeline.filter(row => row.date >= today);
    const historical = fullTimeline.filter(row => row.date < today);
    const currentRow = historical.length ? historical[historical.length - 1] : null;
    const currentDebt = currentRow ? currentRow.endingDebt : (loan.initialAmount + (loan.loanChanges || []).reduce((sum, change) => sum + change.amount, 0));
    const monthsRemaining = forecast.length;
    const lastForecastRow = forecast.length ? forecast[forecast.length - 1] : null;
    const completionDate = lastForecastRow ? UIHandler.formatDate(lastForecastRow.paymentDate) : "-";
    const isLend = loan.loanType === "lend";
    const debtLabel = isLend ? LanguageService.translate("owedToYou") : LanguageService.translate("remainingDebt");
    const isShared = !!loan._shared;
    const typeLabel = (loan.loanType === "lend" ? LanguageService.translate("badgeLending") : LanguageService.translate("badgeBorrowing"));
    const menuHtml = isShared
      ? `<div class="loan-detail-menu-wrap">
            <button type="button" class="loan-detail-menu-btn" data-loan-index="${index}" data-action="menu" aria-haspopup="true" aria-expanded="false">
              <span class="material-icons">more_vert</span>
            </button>
            <div class="loan-detail-menu" role="menu">
              <button type="button" role="menuitem" data-action="edit" data-loan-index="${index}">${LanguageService.translate("edit")}</button>
              <button type="button" role="menuitem" data-action="duplicate" data-loan-index="${index}">${LanguageService.translate("duplicate")}</button>
              <button type="button" role="menuitem" data-action="remove-shared" data-loan-index="${index}">${LanguageService.translate("removeFromMyList")}</button>
            </div>
          </div>`
      : `<div class="loan-detail-menu-wrap">
            <button type="button" class="loan-detail-menu-btn" data-loan-index="${index}" data-action="menu" aria-haspopup="true" aria-expanded="false">
              <span class="material-icons">more_vert</span>
            </button>
            <div class="loan-detail-menu" role="menu">
              <button type="button" role="menuitem" data-action="edit" data-loan-index="${index}">${LanguageService.translate("edit")}</button>
              <button type="button" role="menuitem" data-action="duplicate" data-loan-index="${index}">${LanguageService.translate("duplicate")}</button>
              <button type="button" role="menuitem" data-action="delete" data-loan-index="${index}">${LanguageService.translate("delete")}</button>
            </div>
          </div>`;
    return `
      <div class="loan-card-compact" data-loan-index="${index}" data-action="open" data-loan-type="${loan.loanType || "borrow"}">
        <div class="loan-card-compact-info">
          <span class="loan-card-type-badge" data-type="${loan.loanType || "borrow"}">${escapeHtml(typeLabel)}</span>
          <h3>${escapeHtml(loan.name)}</h3>
          <div class="loan-card-compact-meta">
            <span>${debtLabel}: ${UIHandler.formatCurrency(currentDebt, loan.currency)}</span>
            <span>${LanguageService.translate("monthsRemaining")}: ${monthsRemaining}</span>
            <span>${LanguageService.translate("completionDate")}: ${completionDate}</span>
          </div>
        </div>
        <div class="loan-card-compact-actions">
          <button type="button" class="btn-open btn-primary" data-loan-index="${index}" data-action="open">${LanguageService.translate("openLoan")}</button>
          ${menuHtml}
        </div>
      </div>
    `;
  },
  /** Card click to open loan; three-dot menu is handled by delegated listener on .container. */
  bindCompactCardMenus() {
    const merged = this._mergedLoansList || [];
    document.querySelectorAll(".loan-card-compact").forEach(card => {
      const index = parseInt(card.getAttribute("data-loan-index"), 10);
      const item = merged[index];
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-action=menu]") || e.target.closest(".loan-detail-menu")) return;
        if (e.target.closest("[data-action=open]")) {
          if (item && item._shared) {
            UIHandler.currentShare = item._shared;
            UIHandler.currentDetailLoanIndex = null;
            UIHandler.showSharedLoan();
          } else {
            UIHandler.currentShare = null;
            UIHandler.showLoanDetail(item != null && item._myIndex !== undefined ? item._myIndex : index);
          }
        }
      });
    });
  },
  _pendingRemoveShared: null,
  showRemoveSharedLoanModal(sharedRef) {
    const ownerName = (sharedRef.share && sharedRef.share.owner_display_name) || LanguageService.translate("someone");
    this._pendingRemoveShared = sharedRef;
    document.getElementById("remove-shared-loan-title").textContent = LanguageService.translate("removeSharedLoanTitle");
    document.getElementById("remove-shared-loan-message").textContent = (LanguageService.translate("removeSharedLoanMessage") || "This shared loan will be removed from your list. The loan will remain in {owner}'s account.").replace("{owner}", ownerName);
    document.getElementById("confirm-remove-shared-btn").textContent = LanguageService.translate("removeFromMyList");
    document.body.style.overflow = "hidden";
    document.getElementById("remove-shared-loan-modal").style.display = "flex";
  },
  async confirmRemoveSharedLoan() {
    if (!this._pendingRemoveShared) return;
    const token = this._pendingRemoveShared.token;
    this._pendingRemoveShared = null;
    document.getElementById("remove-shared-loan-modal").style.display = "none";
    this.restoreBodyScroll();
    const result = await ShareService.revokeShareAsRecipient(token);
    if (result.error) {
      this.showFeedback(result.error);
      return;
    }
    this.sharesReceived = (this.sharesReceived || []).filter(s => s.token !== token);
    this.renderLoans();
    this.showFeedback(LanguageService.translate("sharedLoanRemovedFromList"));
  },
  cancelRemoveSharedLoan() {
    this._pendingRemoveShared = null;
    document.getElementById("remove-shared-loan-modal").style.display = "none";
    this.restoreBodyScroll();
  },
  async duplicateSharedLoanToMyList() {
    const loan = this.getSharedLoanForDisplay();
    if (!loan) return;
    const copy = { ...loan, id: crypto.randomUUID(), name: (LanguageService.translate("copyOf") || "Copy of {name}").replace(/\{name\}/g, loan.name || "") };
    const current = StorageService.load("loanData") || [];
    const updated = [...current, copy];
    StorageService.save("loanData", updated);
    if (!localStorage.getItem("offlineMode") && typeof SyncService !== "undefined") await SyncService.syncData();
    this.currentShare = null;
    this.showLoanList();
    this.showLoanDetail(updated.length - 1);
    this.showFeedback(LanguageService.translate("loanDuplicated"));
  },
  showLoanList() {
    this.currentDetailLoanIndex = null;
    this.currentShare = null;
    document.getElementById("view-list").style.display = "block";
    document.getElementById("view-detail").style.display = "none";
    const sharedByEl = document.getElementById("shared-by-line");
    if (sharedByEl) sharedByEl.classList.add("hidden");
    const menuWrap = document.getElementById("loan-detail-header-menu-wrap");
    if (menuWrap) menuWrap.style.display = "";
    this.renderLoans();
    this.restoreBodyScroll();
  },
  showLoanDetail(index) {
    this.currentShare = null;
    this.currentDetailLoanIndex = index;
    document.getElementById("view-list").style.display = "none";
    document.getElementById("view-detail").style.display = "block";
    const loans = StorageService.load("loanData");
    const loan = loans[index];
    if (!loan) { this.showLoanList(); return; }
    document.getElementById("loan-detail-name").textContent = loan.name;
    const sharedByEl = document.getElementById("shared-by-line");
    if (sharedByEl) sharedByEl.classList.add("hidden");
    const headerMenuWrap = document.getElementById("loan-detail-header-menu-wrap");
    if (headerMenuWrap) {
      headerMenuWrap.setAttribute("data-loan-index", String(index));
      headerMenuWrap.removeAttribute("data-shared");
      headerMenuWrap.style.display = "";
      const menu = headerMenuWrap.querySelector(".overview-detail-menu");
      if (menu) {
        menu.innerHTML = `
          <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
          <button type="button" role="menuitem" data-action="share">${LanguageService.translate("shareLoan")}</button>
          <button type="button" role="menuitem" data-action="duplicate">${LanguageService.translate("duplicate")}</button>
          <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
        `;
      }
    }
    this.renderDetailContent();
    document.querySelectorAll(".loan-detail-tab").forEach(t => t.classList.remove("active"));
    document.querySelector(".loan-detail-tab[data-tab=overview]").classList.add("active");
    this.restoreBodyScroll();
  },
  getCurrentLoan() {
    if (this.currentShare && this.currentShare.share) {
      return this.getSharedLoanForDisplay();
    }
    const index = this.currentDetailLoanIndex;
    if (index == null) return null;
    const loans = StorageService.load("loanData") || [];
    return loans[index] || null;
  },
  getSharedLoanForDisplay() {
    if (!this.currentShare || !this.currentShare.share) return null;
    const s = this.currentShare.share;
    const loan = s.loan_snapshot || {};
    const recipientView = s.recipient_view || "borrowing";
    return { ...loan, loanType: recipientView === "lending" ? "lend" : "borrow" };
  },
  showSharedLoan() {
    this.currentDetailLoanIndex = null;
    document.getElementById("view-list").style.display = "none";
    document.getElementById("view-detail").style.display = "block";
    const loan = this.getSharedLoanForDisplay();
    if (!loan) { this.currentShare = null; this.showLoanList(); return; }
    document.getElementById("loan-detail-name").textContent = loan.name;
    const headerMenuWrap = document.getElementById("loan-detail-header-menu-wrap");
    const sharedByEl = document.getElementById("shared-by-line");
    const ownerName = (this.currentShare.share.owner_display_name || "").trim() || LanguageService.translate("someone");
    const sharedByText = (LanguageService.translate("sharedBy") || "Shared by {name}").replace("{name}", ownerName);
    if (sharedByEl) {
      sharedByEl.textContent = sharedByText;
      sharedByEl.classList.remove("hidden");
    }
    if (headerMenuWrap) {
      headerMenuWrap.style.display = "";
      headerMenuWrap.removeAttribute("data-loan-index");
      headerMenuWrap.setAttribute("data-shared", "true");
      const menu = headerMenuWrap.querySelector(".overview-detail-menu");
      if (menu) {
        menu.innerHTML = `
          <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
          <button type="button" role="menuitem" data-action="duplicate">${LanguageService.translate("duplicate")}</button>
          <button type="button" role="menuitem" data-action="remove-shared">${LanguageService.translate("removeFromMyList")}</button>
        `;
      }
    }
    this.renderDetailContent();
    document.querySelectorAll(".loan-detail-tab").forEach(t => t.classList.remove("active"));
    document.querySelector(".loan-detail-tab[data-tab=overview]").classList.add("active");
    this.restoreBodyScroll();
  },
  renderDetailContent() {
    const loan = this.getCurrentLoan();
    if (!loan) return;
    const index = this.currentDetailLoanIndex != null ? this.currentDetailLoanIndex : 0;
    const canEditShared = !this.currentShare || this.currentShare.share?.permission !== "view";
    const activeTab = (document.querySelector(".loan-detail-tab.active") || {}).getAttribute("data-tab") || "overview";
    const overviewHtml = this.createDetailOverview(loan, index);
    const amortizationsHtml = this.createDetailAmortizations(loan, index, canEditShared);
    const targetHtml = this.createDetailTarget(loan, index);
    const chartHtml = this.createDetailChart(index);
    document.getElementById("loan-detail-content").innerHTML = `
      <div class="tab-pane active" data-pane="overview">${overviewHtml}</div>
      <div class="tab-pane" data-pane="amortizations">${amortizationsHtml}</div>
      <div class="tab-pane" data-pane="target">${targetHtml}</div>
      <div class="tab-pane" data-pane="chart">${chartHtml}</div>
    `;
    document.querySelectorAll("#loan-detail-content .tab-pane").forEach(p => p.classList.remove("active"));
    const pane = document.querySelector(`#loan-detail-content .tab-pane[data-pane=${activeTab}]`);
    if (pane) pane.classList.add("active");
  },
  createDetailOverview(loan, index) {
    const fullTimeline = CalculationService.buildTimeline(loan);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const historical = fullTimeline.filter(row => row.date < today);
    const forecast = fullTimeline.filter(row => row.date >= today);
    const currentRow = historical.length ? historical[historical.length - 1] : null;
    const currentDebt = currentRow ? currentRow.endingDebt : (loan.initialAmount + (loan.loanChanges || []).reduce((sum, change) => sum + change.amount, 0));
    const currentRate = currentRow ? currentRow.interestRate : loan.interestRate || 0;
    const interestChangesSorted = (loan.interestChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const firstDayOfCurrentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const nextChange = interestChangesSorted.find(ch => new Date(ch.date) >= firstDayOfCurrentMonth);
    const nextMonthDate = nextChange ? new Date(today.getFullYear(), today.getMonth() + 1, 1) : null;
    const upcomingRateLabel = nextChange && nextMonthDate
      ? `${LanguageService.translate("upcomingRateFrom")} ${UIHandler.formatDate(nextMonthDate.toISOString().slice(0, 10))}` : "";
    const upcomingRateValue = nextChange ? `${parseFloat(nextChange.rate).toFixed(2)}%` : "";
    const totalInterestOverall = fullTimeline.reduce((sum, r) => sum + r.interest, 0);
    const totalPaymentsOverall = fullTimeline.reduce((sum, r) => sum + r.payment, 0);
    const monthsRemaining = forecast.length;
    const lastForecastRow = forecast.length ? forecast[forecast.length - 1] : null;
    const completionDate = lastForecastRow ? UIHandler.formatDate(lastForecastRow.paymentDate) : "-";
    const monthlyPaymentStr = forecast.length && fullTimeline[historical.length]
      ? UIHandler.formatCurrency(fullTimeline[historical.length].payment, loan.currency) : "-";
    const paymentSummary = UIHandler.formatPaymentSummary(loan);
    const interestRows = (!loan.interestChanges || !loan.interestChanges.length)
      ? `<div class="overview-row"><span class="overview-label">-</span><span class="overview-value">-</span></div>`
      : interestChangesSorted.map(ch => `
        <div class="overview-row">
          <span class="overview-label">${escapeHtml(UIHandler.formatDate(ch.date))}</span>
          <span class="overview-value">${escapeHtml(String(ch.rate))}%</span>
        </div>`).join("");
    const loanChangesSorted = (loan.loanChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const loanChangeRows = (!loan.loanChanges || !loan.loanChanges.length)
      ? `<div class="overview-row"><span class="overview-label">-</span><span class="overview-value">-</span></div>`
      : loanChangesSorted.map(ch => `
        <div class="overview-row">
          <span class="overview-label">${escapeHtml(UIHandler.formatDate(ch.date))}</span>
          <span class="overview-value">${UIHandler.formatCurrency(ch.amount, loan.currency)}</span>
        </div>`).join("");
    const forecastContent = (!loan.payments || loan.payments.length === 0)
      ? `<div class="overview-row"><span class="overview-label">${LanguageService.translate("noAmortizationPlan")}</span><span class="overview-value">-</span></div>`
      : `
        <div class="overview-row"><span class="overview-label">${LanguageService.translate("monthsRemaining")}</span><span class="overview-value">${monthsRemaining}</span></div>
        <div class="overview-row"><span class="overview-label">${LanguageService.translate("totalInterest")}</span><span class="overview-value">${UIHandler.formatCurrency(totalInterestOverall, loan.currency)}</span></div>
        <div class="overview-row"><span class="overview-label">${LanguageService.translate("completionDate")}</span><span class="overview-value">${completionDate}</span></div>
        <div class="overview-row"><span class="overview-label">${LanguageService.translate("totalAmountPaid")}</span><span class="overview-value">${UIHandler.formatCurrency(totalPaymentsOverall, loan.currency)}</span></div>`;
    const isLend = loan.loanType === "lend";
    const debtLabel = isLend ? LanguageService.translate("owedToYou") : LanguageService.translate("remainingDebt");
    const monthlyLabel = isLend ? LanguageService.translate("incomingThisMonth") : LanguageService.translate("paymentThisMonth");
    const statusRows = [
      { label: LanguageService.translate("startDate"), value: UIHandler.formatDate(loan.startDate) },
      { label: LanguageService.translate("initialAmount"), value: UIHandler.formatCurrency(loan.initialAmount, loan.currency) },
      { label: debtLabel, value: UIHandler.formatCurrency(currentDebt, loan.currency) },
      { label: LanguageService.translate("currentRate"), value: currentRate.toFixed(2) + "%" },
      ...(upcomingRateLabel ? [{ label: upcomingRateLabel, value: upcomingRateValue }] : [])
    ].map(r => `<div class="overview-row"><span class="overview-label">${r.label}</span><span class="overview-value">${r.value}</span></div>`).join("");
    return `
      <div class="loan-detail-overview">
        <div class="overview-summary">
          <div class="overview-summary-item">
            <span class="overview-summary-value">${UIHandler.formatCurrency(currentDebt, loan.currency)}</span>
            <span class="overview-summary-label">${debtLabel}</span>
          </div>
          <div class="overview-summary-item">
            <span class="overview-summary-value">${currentRate.toFixed(2)}%</span>
            <span class="overview-summary-label">${LanguageService.translate("currentRate")}</span>
          </div>
          <div class="overview-summary-item">
            <span class="overview-summary-value">${monthsRemaining}</span>
            <span class="overview-summary-label">${LanguageService.translate("monthsRemaining")}</span>
          </div>
          <div class="overview-summary-item">
            <span class="overview-summary-value">${completionDate}</span>
            <span class="overview-summary-label">${LanguageService.translate("completionDate")}</span>
          </div>
          <div class="overview-summary-item">
            <span class="overview-summary-value">${monthlyPaymentStr}</span>
            <span class="overview-summary-label">${monthlyLabel}</span>
          </div>
        </div>
        <div class="overview-cards">
          <div class="overview-card">
            <h4 class="overview-card-title">${LanguageService.translate("currentStatus")}</h4>
            ${statusRows}
          </div>
          <div class="overview-card">
            <h4 class="overview-card-title">${LanguageService.translate("forecast")}</h4>
            ${forecastContent}
          </div>
          <div class="overview-card">
            <h4 class="overview-card-title">${LanguageService.translate("amortizationplan")}</h4>
            <div class="overview-card-content overview-payment-summary">${paymentSummary}</div>
          </div>
          <div class="overview-card">
            <h4 class="overview-card-title">${LanguageService.translate("interestChanges")}</h4>
            ${interestRows}
          </div>
          <div class="overview-card">
            <h4 class="overview-card-title">${LanguageService.translate("loanChanges")}</h4>
            ${loanChangeRows}
          </div>
        </div>
      </div>
    `;
  },
  createDetailAmortizations(loan, index, canEdit) {
    const timeline = CalculationService.buildTimeline(loan);
    const tableHtml = timeline.length ? UIHandler.createTimelineTable(timeline, loan.currency, loan) : `<p>${LanguageService.translate("noAmortizationPlan")}</p>`;
    return `
      <div class="loan-detail-amortizations">
        <h4 class="amortizations-section-title">${LanguageService.translate("amortizationSchedule")}</h4>
        ${tableHtml}
        <div class="loan-detail-payment-plans">
          <h4 class="amortizations-section-title">${LanguageService.translate("paymentPlans")}</h4>
          ${UIHandler.createAmortizationListContent(loan, index, canEdit !== false)}
        </div>
      </div>
    `;
  },
  createDetailTarget(loan, index) {
    return `
      <div class="overview-card target-date-card">
        <h4 class="overview-card-title">${LanguageService.translate("targetCompletionDate")}</h4>
        <div class="target-date-controls">
          <input type="date" id="target-date-input-${index}" data-loan-index="${index}" class="target-date-input">
          <button type="button" class="btn-calculate-target btn-primary" data-loan-index="${index}">${LanguageService.translate("calculate")}</button>
        </div>
        <div id="target-date-result-${index}" class="target-date-result hidden">
          <p class="target-date-required-msg"></p>
          <button type="button" class="btn-apply-target-payment btn-primary" data-loan-index="${index}">${LanguageService.translate("addAsPayment")}</button>
        </div>
      </div>
    `;
  },
  createDetailChart(index) {
    return `
      <div class="overview-card detail-chart-card">
        <h4 class="overview-card-title">${LanguageService.translate("amortizationOverTime")}</h4>
        <div id="loan-detail-chart-container"></div>
      </div>
    `;
  },
  formatInterestChanges(changes, currency) {
    if (!changes || !changes.length) return `<p>-</p>`;
    const sorted = changes.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    return sorted.map(ch => `<p>${escapeHtml(UIHandler.formatDate(ch.date))}: ${escapeHtml(String(ch.rate))}%</p>`).join("");
  },
  formatPaymentSummary(loan) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const activePayments = (loan.payments || []).filter(p => {
      let ps = new Date(p.startDate); ps.setHours(0,0,0,0);
      if (p.type === "one-time") return ps > now;
      else {
        if (p.endDate) {
          let pe = new Date(p.endDate); pe.setHours(0,0,0,0);
          return pe >= now;
        }
        return true;
      }
    });
    /** Per frequency key: { amount, startsAt } where startsAt is earliest future start date (ISO string) or null. */
    let scheduled = {};
    let oneTime = [];
    for (let p of activePayments) {
      if (p.type === "scheduled") {
        const unit = p.frequencyUnit || "month";
        const freq = parseInt(p.frequency || "1", 10);
        let key = "";
        if (unit === "week") {
          key = freq === 1 ? LanguageService.translate("weeklyPayment") : LanguageService.translate("everyWeeksPayment").replace("{freq}", freq);
        } else {
          if (freq === 1) key = LanguageService.translate("monthlyPayment");
          else if (freq === 2) key = LanguageService.translate("biMonthlyPayment");
          else if (freq === 3) key = LanguageService.translate("triMonthlyPayment");
          else key = LanguageService.translate("everyMonthsPayment").replace("{freq}", freq);
        }
        const ps = new Date(p.startDate); ps.setHours(0, 0, 0, 0);
        const startsInFuture = ps > now;
        const existing = scheduled[key];
        if (!existing) {
          scheduled[key] = { amount: p.amount, startsAt: startsInFuture ? p.startDate : null };
        } else {
          existing.amount += p.amount;
          if (startsInFuture && (!existing.startsAt || p.startDate < existing.startsAt)) existing.startsAt = p.startDate;
        }
      } else {
        oneTime.push({ date: p.startDate, key: LanguageService.translate("oneTimeAmortization"), amount: p.amount });
      }
    }
    let summaryHTML = "";
    if (Object.keys(scheduled).length > 0) {
      summaryHTML += `<div><strong>${LanguageService.translate("scheduledAmortization")}:</strong><ul>`;
      for (let key in scheduled) {
        const entry = scheduled[key];
        const amountStr = UIHandler.formatCurrency(entry.amount, loan.currency);
        const startsStr = entry.startsAt ? ` — ${LanguageService.translate("startsOn")} ${UIHandler.formatDate(entry.startsAt)}` : "";
        summaryHTML += `<li>${key}: ${amountStr}${startsStr}</li>`;
      }
      summaryHTML += "</ul></div>";
    }
    if (oneTime.length > 0) {
      summaryHTML += `<div><strong>${LanguageService.translate("oneTimeAmortization")}:</strong><ul>`;
      for (let p of oneTime) {
        summaryHTML += `<li>${UIHandler.formatDate(p.date)} - ${p.key}: ${UIHandler.formatCurrency(p.amount, loan.currency)}</li>`;
      }
      summaryHTML += "</ul></div>";
    }
    return summaryHTML;
  },
  formatDate(date) {
    if (!date) return "";
    return new Date(date).toLocaleDateString(LanguageService.currentLanguage === "sv" ? "sv-SE" : "en-US");
  },
  formatCurrency(amount, currency = "SEK") {
    return new Intl.NumberFormat(LanguageService.currentLanguage === "sv" ? "sv-SE" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(amount || 0);
  },
  createTimelineRow(row, i, fullTimeline, forecastCount, historicalCount, currency) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isForecast = row.date >= today;
    const isCurrent = (row.date.getFullYear() === today.getFullYear() &&
                       row.date.getMonth() === today.getMonth());
    const monthsLeftDisplay = isForecast ? (forecastCount - (i - historicalCount)) : "";
    let rowClass = "";
    if (isCurrent) rowClass += " current-month";
    let hasLoanIncrease = false, hasLoanDecrease = false, hasInterestChange = false;
    if (row.changes) {
      row.changes.forEach(ch => {
        if (ch.type === "loan") {
          if (ch.value > 0) { hasLoanIncrease = true; }
          else { hasLoanDecrease = true; }
        }
        if (ch.type === "interest") { hasInterestChange = true; }
      });
    }
    if (hasLoanIncrease) rowClass += " loan-increase-highlight";
    else if (hasLoanDecrease) rowClass += " loan-decrease-highlight";
    else if (hasInterestChange) rowClass += " interest-change-highlight";
    const dateCell = UIHandler.formatDate(row.paymentDate);
    const amortCell = UIHandler.formatCurrency(row.amortization, currency);
    const interestCell = UIHandler.formatCurrency(row.interest, currency);
    let bp = row.paymentBreakdown;
    let paymentCell = "";
    if (bp && Object.keys(bp).length > 1) {
      const tooltipContent = Object.entries(bp)
        .map(([k, v]) => `${k}: ${UIHandler.formatCurrency(v, currency)}`)
        .join('\n');
      paymentCell = `<span class="tooltip-container">
                       <span class="material-icons payment-icon">layers</span>
                       <span class="tooltip-text">${tooltipContent}</span>
                     </span> ${UIHandler.formatCurrency(row.payment, currency)}`;
    } else {
      paymentCell = UIHandler.formatCurrency(row.payment, currency);
    }
    let debtCell = "";
    if (row.changes) {
      const loanChange = row.changes.find(ch => ch.type === "loan");
      if (loanChange) {
        const isIncrease = loanChange.value > 0;
        debtCell = `<span class="tooltip-container">
                      <span class="material-icons ${isIncrease ? 'increase-icon' : 'decrease-icon'}">
                        ${isIncrease ? 'arrow_upward' : 'arrow_downward'}
                      </span>
                      <span class="tooltip-text">
                        ${LanguageService.translate(isIncrease ? 'tooltipLoanIncrease' : 'tooltipLoanDecrease')} ${isIncrease ? loanChange.value : Math.abs(loanChange.value)}
                      </span>
                    </span> ${UIHandler.formatCurrency(row.endingDebt, currency)}`;
      }
    }
    if (!debtCell) {
      debtCell = UIHandler.formatCurrency(row.endingDebt, currency);
    }
    let interestRateCell = "";
    if (row.changes) {
      const interestChange = row.changes.find(ch => ch.type === "interest");
      if (interestChange) {
        interestRateCell = `<span class="tooltip-container">
                              <span class="material-icons interest-icon">sync</span>
                              <span class="tooltip-text">
                                ${LanguageService.translate('tooltipInterestChange')} ${interestChange.value}%
                              </span>
                            </span> ${row.interestRate.toFixed(2)}%`;
      }
    }
    if (!interestRateCell) {
      interestRateCell = row.interestRate.toFixed(2) + "%";
    }
    const firstCellContent = isCurrent
      ? `<span class="current-month-badge">${LanguageService.translate('today')}</span> ${monthsLeftDisplay}`.trim()
      : monthsLeftDisplay;
    return `
      <tr class="${rowClass}">
        <td ${isCurrent ? `data-tooltip="${LanguageService.translate('currentMonth')}"` : ''}>${firstCellContent}</td>
        <td>${dateCell}</td>
        <td>${amortCell}</td>
        <td>${interestCell}</td>
        <td>${paymentCell}</td>
        <td>${debtCell}</td>
        <td>${interestRateCell}</td>
      </tr>
    `;
  },
  createTimelineTable(timeline, currency = "SEK", loanOptional) {
    if (!timeline.length) return `<p>${LanguageService.translate("noAmortizationPlan")}</p>`;
    const debtColLabel = (loanOptional && loanOptional.loanType === "lend") ? LanguageService.translate("owedToYou") : LanguageService.translate("remainingDebt");
    const today = new Date();
    today.setHours(0,0,0,0);
    const historical = timeline.filter(row => row.date < today);
    const forecast = timeline.filter(row => row.date >= today);
    const historicalCount = historical.length;
    const forecastCount = forecast.length;
    return `
      <div class="table-container">
        <div class="table-header-wrapper">
          <table class="amortization-table">
            <thead>
              <tr>
                <th>${LanguageService.translate("monthsRemaining")}</th>
                <th>${LanguageService.translate("date")}</th>
                <th>${LanguageService.translate("amortization")}</th>
                <th>${LanguageService.translate("interestCost")}</th>
                <th>${LanguageService.translate("payment")}</th>
                <th>${debtColLabel}</th>
                <th>${LanguageService.translate("interestRate")}</th>
              </tr>
            </thead>
          </table>
        </div>
        <div class="table-body-scroll">
          <table class="amortization-table">
            <tbody>
              ${timeline.map((row, i) => UIHandler.createTimelineRow(row, i, timeline, forecastCount, historicalCount, currency)).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },
  getPaymentFrequencyLabel(payment) {
    if (payment.type !== "scheduled") return "-";
    const unit = payment.frequencyUnit || "month";
    const freq = parseInt(payment.frequency || "1", 10);
    if (unit === "week") {
      return freq === 1 ? LanguageService.translate("weeklyPayment") : LanguageService.translate("everyWeeksPayment").replace("{freq}", freq);
    }
    if (freq === 1) return LanguageService.translate("monthlyPayment");
    if (freq === 2) return LanguageService.translate("biMonthlyPayment");
    if (freq === 3) return LanguageService.translate("triMonthlyPayment");
    return LanguageService.translate("everyMonthsPayment").replace("{freq}", freq);
  },
  createAmortRow(loan, payment, loanIndex, paymentIndex, canEdit = true) {
    const status = UIHandler.derivePaymentStatus(loan, payment);
    const inactiveClass = (payment.endDate && (new Date(payment.endDate) < new Date())) ? " inactive-payment" : "";
    const actionsCell = canEdit ? `
        <td>
          <div class="payment-plan-menu-wrap" data-loan-index="${loanIndex}" data-payment-index="${paymentIndex}">
            <button type="button" class="payment-plan-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
              <span class="material-icons">more_vert</span>
            </button>
            <div class="payment-plan-menu dropdown-menu" role="menu">
              <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
              <button type="button" role="menuitem" data-action="duplicate">${LanguageService.translate("duplicate")}</button>
              <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
            </div>
          </div>
        </td>` : `<td>-</td>`;
    return `
      <tr class="${inactiveClass}">
        <td>${UIHandler.formatCurrency(payment.amount, loan.currency)}</td>
        <td>${UIHandler.formatDate(payment.startDate)}</td>
        <td>${payment.endDate ? UIHandler.formatDate(payment.endDate) : "-"}</td>
        <td>${payment.type === "scheduled" ? LanguageService.translate("scheduledAmortization") : LanguageService.translate("oneTimeAmortization")}</td>
        <td>${payment.type === "scheduled" ? UIHandler.getPaymentFrequencyLabel(payment) : "-"}</td>
        <td>${UIHandler.derivePaymentStatus(loan, payment)}</td>
        ${actionsCell}
      </tr>
    `;
  },
  derivePaymentStatus(loan, payment) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const ps = new Date(payment.startDate);
    ps.setHours(0, 0, 0, 0);
    if (payment.endDate) {
      const pe = new Date(payment.endDate);
      pe.setHours(0, 0, 0, 0);
      if (now > pe) return LanguageService.translate("inactive");
    }
    return LanguageService.translate("active");
  },
  createAmortizationListContent(loan, loanIndex, canEdit = true) {
    const addBtn = canEdit ? `<button type="button" class="btn-add-amortization btn-primary" data-loan-index="${loanIndex}" data-action="add-amortization">
      <span class="material-icons">add</span>
      <span>${LanguageService.translate("add")}</span>
    </button>` : "";
    if (!loan.payments || !loan.payments.length) {
      return `<div class="payment-plans-header">${addBtn}</div>
              <p>${LanguageService.translate("noAmortizations")}</p>`;
    }
    return `
      <div class="amortization-content">
        <div class="payment-plans-header">${addBtn}</div>
        <div class="table-container">
          <table class="amortization-table">
            <thead>
              <tr>
                <th>${LanguageService.translate("amount")}</th>
                <th>${LanguageService.translate("date")}</th>
                <th>${LanguageService.translate("endDate")}</th>
                <th>${LanguageService.translate("type")}</th>
                <th>${LanguageService.translate("frequency")}</th>
                <th>${LanguageService.translate("status")}</th>
                <th>${LanguageService.translate("actions")}</th>
              </tr>
            </thead>
            <tbody>
              ${loan.payments.map((payment, i) => UIHandler.createAmortRow(loan, payment, loanIndex, i, canEdit)).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },
  showModal(id) {
    document.body.style.overflow = "hidden";
    document.getElementById(id).style.display = "flex";
  },
  closeModal(id) {
    document.getElementById(id).style.display = "none";
    this.restoreBodyScroll();
  },
  /** Show HTML confirm modal (replaces window.confirm). Options: { title, message?, confirmLabel, confirmClass?, cancelLabel?, onConfirm, onCancel? } */
  showConfirmModal(options) {
    const { title, message = "", confirmLabel, confirmClass = "btn-primary", cancelLabel, onConfirm, onCancel } = options;
    document.getElementById("generic-confirm-title").textContent = title;
    const msgEl = document.getElementById("generic-confirm-message");
    msgEl.textContent = message;
    msgEl.style.display = message ? "block" : "none";
    const btn = document.getElementById("generic-confirm-btn");
    btn.textContent = confirmLabel;
    btn.className = confirmClass;
    const cancelBtn = document.getElementById("generic-confirm-cancel-btn");
    cancelBtn.textContent = cancelLabel != null ? cancelLabel : LanguageService.translate("cancel");
    window._genericConfirmOnConfirm = onConfirm;
    window._genericConfirmOnCancel = typeof onCancel === "function" ? onCancel : null;
    this.showModal("generic-confirm-modal");
  },
  cancelGenericConfirm() {
    window._genericConfirmOnConfirm = null;
    window._genericConfirmOnCancel = null;
    this.closeModal("generic-confirm-modal");
  },
  /** Show security prompt: 2FA-only when they have recovery but no 2FA (emphasize securing account); combined (2FA + recovery) when they have neither. Never show if they already have 2FA. "Maybe later" re-shows after 7 days. */
  async maybeShowSecurityPrompt() {
    if (localStorage.getItem("offlineMode")) return;
    const user = await AuthService.getUser();
    if (!user || !user.email) return;
    const factors = await AuthService.mfaListFactors();
    const has2FA = factors.data && factors.data.totp && factors.data.totp.length > 0;
    if (has2FA) return;
    const recoveryEmail = (user.user_metadata && user.user_metadata.recovery_email) ? String(user.user_metadata.recovery_email).trim() : "";
    const hasRecoveryEmail = recoveryEmail.length > 0 && recoveryEmail.toLowerCase() !== (user.email || "").toLowerCase();
    const dismissed = localStorage.getItem("lendpile_securityPrompt");
    if (dismissed === "dismissed") return;
    if (dismissed === "later") {
      const laterAt = localStorage.getItem("lendpile_securityPromptLaterAt");
      if (laterAt && new Date() < new Date(laterAt)) return;
    }
    const titleEl = document.getElementById("security-prompt-title");
    const bodyEl = document.getElementById("security-prompt-body");
    if (titleEl && bodyEl) {
      if (hasRecoveryEmail) {
        titleEl.textContent = LanguageService.translate("securityPrompt2faTitle");
        bodyEl.textContent = LanguageService.translate("securityPrompt2faBody");
      } else {
        titleEl.textContent = LanguageService.translate("securityPromptTitle");
        bodyEl.textContent = LanguageService.translate("securityPromptBody");
      }
    }
    this.showModal("security-prompt-modal");
  },
  restoreBodyScroll() {
    const anyOpen = Array.from(document.querySelectorAll(".modal, .confirm-modal")).some(
      (m) => getComputedStyle(m).display === "flex"
    );
    if (!anyOpen) document.body.style.overflow = "";
  },
  populateStartPageSettings() {
    const blobs = getStartPageBlobs();
    const monthlyEl = document.getElementById("start-page-blob-monthly");
    const debtEl = document.getElementById("start-page-blob-debt");
    const monthlyIncomingEl = document.getElementById("start-page-blob-monthly-incoming");
    const owedEl = document.getElementById("start-page-blob-owed");
    const countEl = document.getElementById("start-page-blob-count");
    if (monthlyEl) monthlyEl.checked = !!blobs.totalMonthly;
    if (debtEl) debtEl.checked = !!blobs.totalDebt;
    if (monthlyIncomingEl) monthlyIncomingEl.checked = !!blobs.monthlyIncoming;
    if (owedEl) owedEl.checked = !!blobs.owedToYou;
    if (countEl) countEl.checked = !!blobs.loanCount;
    const excluded = getStartPageExcluded();
    const loans = StorageService.load("loanData") || [];
    const listEl = document.getElementById("start-page-loans-list");
    if (!listEl) return;
    if (!loans.length) {
      listEl.innerHTML = `<p class="start-page-no-loans">${LanguageService.translate("noLoans")}</p>`;
      return;
    }
    listEl.innerHTML = loans.map(loan => {
      const displayName = escapeHtml(loan.name);
      const attrName = String(loan.name).replace(/"/g, "&quot;");
      const included = !excluded.includes(loan.name);
      return `<div class="start-page-loan-row" data-loan-name="${attrName}">
        <label><input type="checkbox" class="start-page-include-checkbox" ${included ? "checked" : ""}> ${displayName}</label>
      </div>`;
    }).join("");
  },
  populateExportLoansList() {
    const loans = StorageService.load("loanData") || [];
    const listEl = document.getElementById("loan-export-list");
    const selectAllEl = document.getElementById("export-select-all");
    const feedbackEl = document.getElementById("export-loans-feedback");
    if (!listEl) return;
    if (feedbackEl) { feedbackEl.style.display = "none"; feedbackEl.textContent = ""; }
    if (!loans.length) {
      listEl.innerHTML = `<p class="start-page-no-loans">${LanguageService.translate("noLoans")}</p>`;
      if (selectAllEl) selectAllEl.checked = false;
      return;
    }
    listEl.innerHTML = loans.map((loan, i) => {
      const displayName = escapeHtml(loan.name);
      return `<label><input type="checkbox" class="loan-export-checkbox" data-loan-index="${i}"> ${displayName}</label>`;
    }).join("");
    if (selectAllEl) selectAllEl.checked = false;
  },
  showFeedback(msg) {
    const fm = document.getElementById("feedback-modal");
    fm.querySelector("p").textContent = msg;
    document.body.style.overflow = "hidden";
    fm.style.display = "flex";
    setTimeout(() => {
      fm.style.display = "none";
      this.restoreBodyScroll();
    }, 2000);
  },
  shareLoanIndex: null,
  openShareModal(loanIndex) {
    this.shareLoanIndex = loanIndex;
    document.getElementById("share-link-result").style.display = "none";
    document.getElementById("share-link-feedback").style.display = "none";
    document.querySelectorAll("#share-loan-modal input[name=share-permission]").forEach(r => { r.checked = r.value === "view"; });
    document.querySelectorAll("#share-loan-modal input[name=share-recipient-view]").forEach(r => { r.checked = r.value === "borrowing"; });
    const sel = document.getElementById("share-expires-days");
    if (sel) sel.value = "7";
    this.showModal("share-loan-modal");
    this.populateShareActiveList();
  },
  async checkTransferOffers() {
    const banner = document.getElementById("transfer-offer-banner");
    if (!banner) return;
    if (localStorage.getItem("offlineMode")) { banner.style.display = "none"; return; }
    const result = await ShareService.listTransferOffers();
    const offers = result.offers || [];
    if (offers.length === 0) {
      banner.style.display = "none";
      banner.innerHTML = "";
      return;
    }
    banner.innerHTML = offers.map(o => {
      const loanName = (o.loan_snapshot && o.loan_snapshot.name) ? escapeHtml(o.loan_snapshot.name) : "";
      const fromName = (o.owner_display_name && String(o.owner_display_name).trim()) ? escapeHtml(o.owner_display_name) : LanguageService.translate("someone");
      return `
        <div class="transfer-offer-item" data-share-id="${o.id}">
          <strong>${fromName}</strong> ${LanguageService.translate("transferOfferTitle")}${loanName ? ` ("${loanName}")` : ""}. ${LanguageService.translate("transferOfferBody")}
          <div class="transfer-offer-actions">
            <button type="button" class="btn-primary transfer-accept-btn" data-share-id="${o.id}">${LanguageService.translate("transferOfferAccept")}</button>
            <button type="button" class="btn-edit transfer-decline-btn" data-share-id="${o.id}">${LanguageService.translate("transferOfferDecline")}</button>
          </div>
        </div>
      `;
    }).join("");
    banner.style.display = "block";
    banner.querySelectorAll(".transfer-accept-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.acceptTransfer(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback(LanguageService.translate("transferReceived"));
          UIHandler.renderLoans();
          UIHandler.checkTransferOffers();
        }
      });
    });
    banner.querySelectorAll(".transfer-decline-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.declineTransfer(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback(LanguageService.translate("transferDeclined"));
          UIHandler.checkTransferOffers();
        }
      });
    });
  },
  async checkEditRequests() {
    const banner = document.getElementById("edit-request-banner");
    if (!banner) return;
    if (localStorage.getItem("offlineMode")) { banner.style.display = "none"; banner.innerHTML = ""; return; }
    const result = await ShareService.listMyShares();
    const shares = (result.shares || []).filter(s => s.edit_requested_at);
    if (shares.length === 0) {
      banner.style.display = "none";
      banner.innerHTML = "";
      return;
    }
    const loanName = (s) => (s.loan_snapshot && s.loan_snapshot.name) ? escapeHtml(s.loan_snapshot.name) : LanguageService.translate("loan");
    const requesterLabel = (s) => {
      const name = (s.recipient_display_name && s.recipient_display_name.trim()) ? s.recipient_display_name.trim() : (s.recipient_email && s.recipient_email.trim()) ? s.recipient_email.trim() : null;
      return name ? escapeHtml(name) : LanguageService.translate("someone");
    };
    banner.innerHTML = shares.map(s => `
      <div class="edit-request-item" data-share-id="${s.id}">
        ${(LanguageService.translate("editRequestBanner") || "Edit access requested for {loanName} by {requester}.").replace("{loanName}", loanName(s)).replace("{requester}", requesterLabel(s))}
        <div class="edit-request-actions">
          <button type="button" class="btn-primary edit-request-approve-btn" data-share-id="${s.id}">${LanguageService.translate("approve")}</button>
          <button type="button" class="btn-edit edit-request-decline-btn" data-share-id="${s.id}">${LanguageService.translate("decline")}</button>
        </div>
      </div>
    `).join("");
    banner.style.display = "block";
    banner.querySelectorAll(".edit-request-approve-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.approveEditRequest(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback(LanguageService.translate("editRequestApproved"));
          UIHandler.checkEditRequests();
          UIHandler.populateShareActiveList();
        }
      });
    });
    banner.querySelectorAll(".edit-request-decline-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.declineEditRequest(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback(LanguageService.translate("editRequestDeclined"));
          UIHandler.checkEditRequests();
          UIHandler.populateShareActiveList();
        }
      });
    });
  },
  async checkEditResolutionBanner() {
    const banner = document.getElementById("edit-resolution-banner");
    if (!banner) return;
    if (localStorage.getItem("offlineMode")) { banner.style.display = "none"; banner.innerHTML = ""; return; }
    const result = await ShareService.listSharesReceived();
    const unseen = (result.shares || []).filter(s => s.edit_request_resolved_at && !s.recipient_seen_resolution_at);
    if (unseen.length === 0) {
      banner.style.display = "none";
      banner.innerHTML = "";
      return;
    }
    const loanName = (s) => (s.loan_snapshot && s.loan_snapshot.name) ? escapeHtml(s.loan_snapshot.name) : LanguageService.translate("loan");
    banner.innerHTML = unseen.map(s => {
      const name = loanName(s);
      const msg = s.edit_request_outcome === "approved"
        ? (LanguageService.translate("editRequestApprovedBanner") || "Your edit access request for {name} was approved.").replace("{name}", name)
        : (LanguageService.translate("editRequestDeclinedBanner") || "Your edit access request for {name} was declined.").replace("{name}", name);
      return `
        <div class="edit-resolution-item" data-share-id="${s.id}">
          ${msg}
          <div class="edit-resolution-actions">
            <button type="button" class="btn-primary edit-resolution-ok-btn" data-share-id="${s.id}">${LanguageService.translate("ok")}</button>
          </div>
        </div>
      `;
    }).join("");
    banner.style.display = "block";
    banner.querySelectorAll(".edit-resolution-ok-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        await ShareService.markEditResolutionSeen(id);
        UIHandler.checkEditResolutionBanner();
      });
    });
  },
  async populateShareActiveList() {
    const loanIndex = this.shareLoanIndex;
    const section = document.getElementById("share-active-list-section");
    const listEl = document.getElementById("share-active-list");
    if (!section || !listEl) return;
    if (loanIndex == null) {
      section.style.display = "none";
      return;
    }
    const loans = StorageService.load("loanData") || [];
    const loan = loans[loanIndex];
    if (!loan || loan.id == null) {
      section.style.display = "none";
      return;
    }
    const loanId = String(loan.id);
    const result = await ShareService.listMyShares();
    const shares = (result.shares || []).filter(s => String(s.loan_id) === loanId);
    section.style.display = shares.length ? "block" : "none";
    if (shares.length === 0) {
      listEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = shares.map(s => {
      const expiresAt = s.expires_at ? new Date(s.expires_at) : null;
      const expired = expiresAt && expiresAt < new Date();
      const expiresStr = expiresAt ? UIHandler.formatDate(expiresAt.toISOString().slice(0, 10)) : "";
      const permLabel = s.permission === "edit" ? LanguageService.translate("shareCanEdit") : LanguageService.translate("shareViewOnly");
      const viewLabel = s.recipient_view === "lending" ? LanguageService.translate("shareLending") : LanguageService.translate("shareBorrowing");
      const recipientLine = s.used_at
        ? " · " + LanguageService.translate("sharedWith") + ": " + escapeHtml(((s.recipient_display_name && s.recipient_display_name.trim()) || (s.recipient_email || "").trim() || LanguageService.translate("signedInUser")))
        : " · " + LanguageService.translate("linkNotUsedYet");
      const expiredLabel = expired ? " (" + LanguageService.translate("shareExpired") + ")" : "";
      const transferPending = s.transfer_requested_at ? " · " + LanguageService.translate("transferPending") : "";
      const showTransferBtn = s.used_at && !s.transfer_requested_at;
      const showCancelTransferBtn = s.used_at && s.transfer_requested_at;
      const editRequested = !!s.edit_requested_at;
      return `
        <div class="share-active-item" data-share-id="${s.id}">
          <div class="share-active-item-meta">
            ${escapeHtml(permLabel)} · ${escapeHtml(viewLabel)} · ${LanguageService.translate("shareExpiresOn")}: ${expiresStr}${recipientLine}${transferPending}${expiredLabel}
            ${editRequested ? "<br><strong>" + (LanguageService.translate("editRequestedByRecipient") || "Recipient requested edit access.") + "</strong>" : ""}
          </div>
          <div class="share-active-item-actions">
            ${editRequested ? `<button type="button" class="btn-primary share-edit-approve-btn" data-share-id="${s.id}">${LanguageService.translate("approve")}</button><button type="button" class="btn-edit share-edit-decline-btn" data-share-id="${s.id}">${LanguageService.translate("decline")}</button>` : ""}
            <select class="share-permission-select" data-share-id="${s.id}" aria-label="${escapeHtml(LanguageService.translate("changePermission"))}">
              <option value="view" ${s.permission === "view" ? "selected" : ""}>${LanguageService.translate("shareViewOnly")}</option>
              <option value="edit" ${s.permission === "edit" ? "selected" : ""}>${LanguageService.translate("shareCanEdit")}</option>
            </select>
            ${showTransferBtn ? `<button type="button" class="btn-primary share-transfer-btn" data-share-id="${s.id}">${LanguageService.translate("transferToRecipient")}</button>` : ""}
            ${showCancelTransferBtn ? `<button type="button" class="btn-edit share-cancel-transfer-btn" data-share-id="${s.id}">${LanguageService.translate("cancelTransferRequest")}</button>` : ""}
            <button type="button" class="btn-delete share-revoke-btn" data-share-id="${s.id}">${LanguageService.translate("revokeShare")}</button>
          </div>
        </div>
      `;
    }).join("");
    listEl.querySelectorAll(".share-edit-approve-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.approveEditRequest(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback(LanguageService.translate("editRequestApproved"));
          UIHandler.populateShareActiveList();
          UIHandler.checkEditRequests();
        }
      });
    });
    listEl.querySelectorAll(".share-edit-decline-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.declineEditRequest(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback(LanguageService.translate("editRequestDeclined"));
          UIHandler.populateShareActiveList();
          UIHandler.checkEditRequests();
        }
      });
    });
    listEl.querySelectorAll(".share-revoke-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        UIHandler.showConfirmModal({
          title: LanguageService.translate("revokeShare") + "?",
          confirmLabel: LanguageService.translate("revokeShare"),
          confirmClass: "btn-delete",
          onConfirm: async () => {
            const r = await ShareService.revokeShare(id);
            if (r.error) UIHandler.showFeedback(r.error);
            else UIHandler.populateShareActiveList();
          }
        });
      });
    });
    listEl.querySelectorAll(".share-transfer-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        UIHandler.showConfirmModal({
          title: LanguageService.translate("transferToRecipientConfirm"),
          confirmLabel: LanguageService.translate("transferToRecipient") || "Transfer",
          confirmClass: "btn-primary",
          onConfirm: async () => {
            const r = await ShareService.requestTransferToRecipient(id);
            if (r.error) UIHandler.showFeedback(r.error);
            else {
              UIHandler.showFeedback(LanguageService.translate("transferRequested"));
              UIHandler.populateShareActiveList();
            }
          }
        });
      });
    });
    listEl.querySelectorAll(".share-cancel-transfer-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-share-id");
        if (!id) return;
        const r = await ShareService.cancelTransferRequest(id);
        if (r.error) UIHandler.showFeedback(r.error);
        else UIHandler.populateShareActiveList();
      });
    });
    listEl.querySelectorAll(".share-permission-select").forEach(sel => {
      sel.addEventListener("change", async () => {
        const id = sel.getAttribute("data-share-id");
        const permission = sel.value;
        if (!id) return;
        const r = await ShareService.updateShare(id, { permission });
        if (r.error) UIHandler.showFeedback(r.error);
        else UIHandler.populateShareActiveList();
      });
    });
  }
};

/********************************************************
 * 5. FORM HANDLER
 ********************************************************/
const FormHandler = {
  changeFormBound: false,
  openLoanModal(index = null) {
    const modal = document.getElementById("loan-modal");
    const form = document.getElementById("loan-form-modal");
    const title = document.getElementById("loan-modal-title");
    const removeBtn = document.getElementById("remove-loan-btn");
    form.removeAttribute("data-shared-view-only");
    const lockWrap = document.getElementById("globalLockControl");
    if (lockWrap) lockWrap.innerHTML = `<span class="material-icons">lock</span><span class="lock-text">${LanguageService.translate("unlockSensitiveFields")}</span>`;
    document.getElementById("add-interest-change-btn").style.display = "";
    document.getElementById("add-loan-change-btn").style.display = "";
    const subBtn = form.querySelector('button[type="submit"]');
    if (subBtn) subBtn.style.display = "";
    form.reset();
    form.removeAttribute("data-loan-index");
    form.removeAttribute("data-edit-mode");
    form.removeAttribute("data-shared-edit");
    document.getElementById("interest-changes-list").innerHTML = "";
    document.getElementById("loan-changes-list").innerHTML = "";
    const borrowBtn = form.querySelector("#loan-type-borrow");
    const lendBtn = form.querySelector("#loan-type-lend");
    const loanTypeInput = form.querySelector("#loanType");
    if (index !== null) {
      const loans = StorageService.load("loanData");
      const loan = loans[index];
      const loanType = loan.loanType === "lend" ? "lend" : "borrow";
      if (borrowBtn) { borrowBtn.classList.toggle("active", loanType === "borrow"); lendBtn.classList.toggle("active", loanType === "lend"); }
      if (loanTypeInput) loanTypeInput.value = loanType;
      form.setAttribute("data-loan-index", index);
      form.setAttribute("data-edit-mode", "true");
      title.textContent = LanguageService.translate("editLoan");
      form.querySelector("#loanName").value = loan.name;
      form.querySelector("#loanStartDate").value = loan.startDate;
      form.querySelector("#loanInitialAmount").value = loan.initialAmount;
      form.querySelector("#loanCurrency").value = loan.currency;
      const interestToShow = (() => {
        const sorted = (loan.interestChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
        const hasAtStart = sorted.length && sorted[0].date <= loan.startDate;
        if (loan.interestRate != null && loan.interestRate !== "" && !hasAtStart) {
          return [{ date: loan.startDate, rate: loan.interestRate }].concat(sorted);
        }
        return sorted;
      })();
      interestToShow.forEach((ch, itemIdx) => {
        const div = document.createElement("div");
        div.className = "change-item";
        div.innerHTML = `
          <div class="change-item-details">
            <span data-date="${escapeHtml(ch.date)}">${LanguageService.translate("date")}: ${escapeHtml(ch.date)}</span>
            <span data-rate="${escapeHtml(String(ch.rate))}">${LanguageService.translate("rate")}: ${escapeHtml(String(ch.rate))}%</span>
          </div>
          <div class="change-item-actions">
            <div class="change-item-menu-wrap" data-change-type="interest" data-item-index="${itemIdx}">
              <button type="button" class="payment-plan-menu-btn change-item-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
                <span class="material-icons">more_vert</span>
              </button>
              <div class="change-item-menu dropdown-menu" role="menu">
                <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
                <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
              </div>
            </div>
          </div>
        `;
        document.getElementById("interest-changes-list").appendChild(div);
      });
      if (loan.loanChanges) {
        loan.loanChanges.forEach((ch, itemIdx) => {
          const div = document.createElement("div");
          div.className = "change-item";
          div.innerHTML = `
            <div class="change-item-details">
              <span data-date="${escapeHtml(ch.date)}">${LanguageService.translate("date")}: ${escapeHtml(ch.date)}</span>
              <span data-amount="${escapeHtml(String(ch.amount))}">${LanguageService.translate("amount")}: ${escapeHtml(String(ch.amount))}</span>
            </div>
            <div class="change-item-actions">
              <div class="change-item-menu-wrap" data-change-type="loan" data-item-index="${itemIdx}">
                <button type="button" class="payment-plan-menu-btn change-item-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
                  <span class="material-icons">more_vert</span>
                </button>
                <div class="change-item-menu dropdown-menu" role="menu">
                  <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
                  <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
                </div>
              </div>
            </div>
          `;
          document.getElementById("loan-changes-list").appendChild(div);
        });
      }
      removeBtn.style.display = "block";
      removeBtn.setAttribute("data-loan-index", index);
      removeBtn.onclick = () => { ConfirmHandler.confirmDelete('loan', index); };
      UIHandler.setLockState(modal, ["loanStartDate", "loanInitialAmount"], true);
      document.getElementById("loan-initial-interest-row").style.display = "none";
      document.getElementById("interest-section-help").style.display = "none";
      document.getElementById("loan-changes-section-help").style.display = "none";
    } else {
      if (borrowBtn) { borrowBtn.classList.add("active"); lendBtn.classList.remove("active"); }
      if (loanTypeInput) loanTypeInput.value = "borrow";
      title.textContent = LanguageService.translate("addLoan");
      removeBtn.style.display = "none";
      removeBtn.removeAttribute("data-loan-index");
      UIHandler.setLockState(modal, ["loanStartDate", "loanInitialAmount"], false);
      document.getElementById("loan-initial-interest-row").style.display = "flex";
      document.getElementById("loanInitialInterestRate").value = "";
      document.getElementById("loanInitialInterestRate").placeholder = LanguageService.currentLanguage === "sv" ? "t.ex. 4,5" : "e.g. 4.5";
      const interestHelp = document.getElementById("interest-section-help");
      interestHelp.textContent = LanguageService.translate("interestSectionHelpNewLoan");
      interestHelp.style.display = "block";
      document.getElementById("loan-changes-section-help").textContent = LanguageService.translate("loanChangesSectionHelpNewLoan");
      document.getElementById("loan-changes-section-help").style.display = "block";
    }
    if (index === null && !form.getAttribute("data-shared-edit")) {
      document.getElementById("loanName").placeholder = LanguageService.translate("placeholderLoanName");
    }
    this.attachChangeHandlers();
    UIHandler.showModal("loan-modal");
  },
  openLoanModalForSharedLoan() {
    if (!UIHandler.currentShare || !UIHandler.currentShare.share) return;
    const share = UIHandler.currentShare.share;
    const loan = share.loan_snapshot;
    if (!loan) return;
    const modal = document.getElementById("loan-modal");
    const form = document.getElementById("loan-form-modal");
    const title = document.getElementById("loan-modal-title");
    const removeBtn = document.getElementById("remove-loan-btn");
    form.removeAttribute("data-shared-view-only");
    const lockWrap = document.getElementById("globalLockControl");
    if (lockWrap) lockWrap.innerHTML = `<span class="material-icons">lock</span><span class="lock-text">${LanguageService.translate("unlockSensitiveFields")}</span>`;
    document.getElementById("add-interest-change-btn").style.display = "";
    document.getElementById("add-loan-change-btn").style.display = "";
    const subBtn = form.querySelector('button[type="submit"]');
    if (subBtn) subBtn.style.display = "";
    form.reset();
    form.removeAttribute("data-loan-index");
    form.removeAttribute("data-edit-mode");
    form.setAttribute("data-shared-edit", "true");
    document.getElementById("interest-changes-list").innerHTML = "";
    document.getElementById("loan-changes-list").innerHTML = "";
    const borrowBtn = form.querySelector("#loan-type-borrow");
    const lendBtn = form.querySelector("#loan-type-lend");
    const loanTypeInput = form.querySelector("#loanType");
    const recipientView = share.recipient_view || "borrowing";
    const displayLoanType = recipientView === "lending" ? "lend" : "borrow";
    if (borrowBtn) { borrowBtn.classList.toggle("active", displayLoanType === "borrow"); lendBtn.classList.toggle("active", displayLoanType === "lend"); }
    if (loanTypeInput) loanTypeInput.value = displayLoanType;
    title.textContent = LanguageService.translate("editLoan");
    form.querySelector("#loanName").value = loan.name || "";
    form.querySelector("#loanStartDate").value = loan.startDate || "";
    form.querySelector("#loanInitialAmount").value = loan.initialAmount ?? "";
    form.querySelector("#loanCurrency").value = loan.currency || "SEK";
    const sharedInterestToShow = (() => {
      const sorted = (loan.interestChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
      const hasAtStart = sorted.length && sorted[0].date <= loan.startDate;
      if (loan.interestRate != null && loan.interestRate !== "" && !hasAtStart) {
        return [{ date: loan.startDate, rate: loan.interestRate }].concat(sorted);
      }
      return sorted;
    })();
    sharedInterestToShow.forEach((ch, itemIdx) => {
      const div = document.createElement("div");
      div.className = "change-item";
      div.innerHTML = `
        <div class="change-item-details">
          <span data-date="${escapeHtml(ch.date)}">${LanguageService.translate("date")}: ${escapeHtml(ch.date)}</span>
          <span data-rate="${escapeHtml(String(ch.rate))}">${LanguageService.translate("rate")}: ${escapeHtml(String(ch.rate))}%</span>
        </div>
        <div class="change-item-actions">
          <div class="change-item-menu-wrap" data-change-type="interest" data-item-index="${itemIdx}" data-shared-edit="true">
            <button type="button" class="payment-plan-menu-btn change-item-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
              <span class="material-icons">more_vert</span>
            </button>
            <div class="change-item-menu dropdown-menu" role="menu">
              <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
              <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById("interest-changes-list").appendChild(div);
    });
    (loan.loanChanges || []).forEach((ch, itemIdx) => {
      const div = document.createElement("div");
      div.className = "change-item";
      div.innerHTML = `
        <div class="change-item-details">
          <span data-date="${escapeHtml(ch.date)}">${LanguageService.translate("date")}: ${escapeHtml(ch.date)}</span>
          <span data-amount="${escapeHtml(String(ch.amount))}">${LanguageService.translate("amount")}: ${escapeHtml(String(ch.amount))}</span>
        </div>
        <div class="change-item-actions">
          <div class="change-item-menu-wrap" data-change-type="loan" data-item-index="${itemIdx}" data-shared-edit="true">
            <button type="button" class="payment-plan-menu-btn change-item-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
              <span class="material-icons">more_vert</span>
            </button>
            <div class="change-item-menu dropdown-menu" role="menu">
              <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
              <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById("loan-changes-list").appendChild(div);
    });
    removeBtn.style.display = "none";
    document.getElementById("loan-initial-interest-row").style.display = "none";
    document.getElementById("interest-section-help").style.display = "none";
    document.getElementById("loan-changes-section-help").style.display = "none";
    UIHandler.setLockState(modal, ["loanStartDate", "loanInitialAmount"], true);
    this.attachChangeHandlers();
    UIHandler.showModal("loan-modal");
  },
  openLoanModalForSharedViewOnly() {
    if (!UIHandler.currentShare || !UIHandler.currentShare.share) return;
    const share = UIHandler.currentShare.share;
    const loan = share.loan_snapshot;
    if (!loan) return;
    const shareId = share.id;
    const modal = document.getElementById("loan-modal");
    const form = document.getElementById("loan-form-modal");
    const title = document.getElementById("loan-modal-title");
    const removeBtn = document.getElementById("remove-loan-btn");
    form.reset();
    form.removeAttribute("data-loan-index");
    form.removeAttribute("data-edit-mode");
    form.removeAttribute("data-shared-edit");
    form.setAttribute("data-shared-view-only", shareId);
    document.getElementById("interest-changes-list").innerHTML = "";
    document.getElementById("loan-changes-list").innerHTML = "";
    const ownerName = (share.owner_display_name || "").trim() || LanguageService.translate("someone");
    const borrowBtn = form.querySelector("#loan-type-borrow");
    const lendBtn = form.querySelector("#loan-type-lend");
    const loanTypeInput = form.querySelector("#loanType");
    const recipientView = share.recipient_view || "borrowing";
    const displayLoanType = recipientView === "lending" ? "lend" : "borrow";
    if (borrowBtn) { borrowBtn.classList.toggle("active", displayLoanType === "borrow"); lendBtn.classList.toggle("active", displayLoanType === "lend"); borrowBtn.disabled = true; lendBtn.disabled = true; }
    if (loanTypeInput) loanTypeInput.value = displayLoanType;
    title.textContent = LanguageService.translate("editLoan");
    form.querySelector("#loanName").value = loan.name || "";
    form.querySelector("#loanStartDate").value = loan.startDate || "";
    form.querySelector("#loanInitialAmount").value = loan.initialAmount ?? "";
    form.querySelector("#loanCurrency").value = loan.currency || "SEK";
    ["loanName", "loanStartDate", "loanInitialAmount", "loanCurrency"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    const sharedInterestToShow = (() => {
      const sorted = (loan.interestChanges || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
      const hasAtStart = sorted.length && sorted[0].date <= loan.startDate;
      if (loan.interestRate != null && loan.interestRate !== "" && !hasAtStart) {
        return [{ date: loan.startDate, rate: loan.interestRate }].concat(sorted);
      }
      return sorted;
    })();
    sharedInterestToShow.forEach((ch) => {
      const div = document.createElement("div");
      div.className = "change-item";
      div.innerHTML = `
        <div class="change-item-details">
          <span>${LanguageService.translate("date")}: ${escapeHtml(ch.date)}</span>
          <span>${LanguageService.translate("rate")}: ${escapeHtml(String(ch.rate))}%</span>
        </div>
      `;
      document.getElementById("interest-changes-list").appendChild(div);
    });
    (loan.loanChanges || []).forEach((ch) => {
      const div = document.createElement("div");
      div.className = "change-item";
      div.innerHTML = `
        <div class="change-item-details">
          <span>${LanguageService.translate("date")}: ${escapeHtml(ch.date)}</span>
          <span>${LanguageService.translate("amount")}: ${escapeHtml(String(ch.amount))}</span>
        </div>
      `;
      document.getElementById("loan-changes-list").appendChild(div);
    });
    document.getElementById("add-interest-change-btn").style.display = "none";
    document.getElementById("add-loan-change-btn").style.display = "none";
    document.getElementById("loan-initial-interest-row").style.display = "none";
    document.getElementById("interest-section-help").style.display = "none";
    document.getElementById("loan-changes-section-help").style.display = "none";
    removeBtn.style.display = "none";
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.style.display = "none";
    const lockWrap = document.getElementById("globalLockControl");
    const alreadyRequested = !!share.edit_requested_at;
    const requestMsg = (LanguageService.translate("viewOnlyRequestEdit") || "View-only. Request edit access from {name}?").replace("{name}", ownerName);
    lockWrap.innerHTML = `
      <span class="material-icons">lock</span>
      <span class="lock-text">${escapeHtml(requestMsg)}</span>
      <button type="button" class="btn-primary view-only-request-btn" id="view-only-request-btn" ${alreadyRequested ? "disabled" : ""}>${alreadyRequested ? (LanguageService.translate("requestAlreadySent") || "Request sent").replace("{name}", ownerName) : LanguageService.translate("requestEditAccess")}</button>
    `;
    if (!alreadyRequested) {
      lockWrap.querySelector("#view-only-request-btn").addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const r = await ShareService.requestEditAccess(shareId);
        if (r.error) UIHandler.showFeedback(r.error);
        else {
          UIHandler.showFeedback((LanguageService.translate("requestAlreadySent") || "Request sent. {name} can grant access from share settings.").replace("{name}", ownerName));
          const btn = lockWrap.querySelector("#view-only-request-btn");
          if (btn) { btn.disabled = true; btn.textContent = (LanguageService.translate("requestAlreadySent") || "Request sent").replace("{name}", ownerName); }
        }
      });
    }
    UIHandler.setLockState(modal, ["loanStartDate", "loanInitialAmount"], true);
    ["loanName", "loanCurrency"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.closest(".loan-field-wrap")?.classList.add("locked-field-container");
    });
    UIHandler.showModal("loan-modal");
  },
  async duplicateLoan(index) {
    const loans = StorageService.load("loanData");
    if (index == null || index < 0 || index >= loans.length) return;
    const source = loans[index];
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = crypto.randomUUID();
    copy.name = (LanguageService.translate("copyOf") || "Copy of {name}").replace(/\{name\}/g, source.name || "");
    loans.push(copy);
    StorageService.save("loanData", loans);
    if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
    UIHandler.renderLoans();
    UIHandler.showFeedback(LanguageService.translate("loanDuplicated"));
  },
  attachChangeHandlers() {
    if (!this.changeFormBound) {
      document.getElementById("add-interest-change-btn").onclick = function() {
        FormHandler.openChangeModal("interest");
      };
      document.getElementById("add-loan-change-btn").onclick = function() {
        FormHandler.openChangeModal("loan");
      };
      document.getElementById("change-form").addEventListener("submit", e => {
        e.preventDefault();
        const changeForm = document.getElementById("change-form");
        const changeType = document.getElementById("changeType").value;
        const date = document.getElementById("changeDate").value;
        const valueRaw = document.getElementById("changeValue").value;
        const value = changeType === "interest" ? (valueRaw === "" || isNaN(parseFloat(valueRaw)) ? 0 : Math.max(0, parseFloat(valueRaw))) : parseFloat(valueRaw);
        if (!date || (changeType !== "interest" && isNaN(value))) return;
        if (changeType === "interest") {
          const loanStart = document.getElementById("loanStartDate").value;
          if (loanStart && date < loanStart) {
            UIHandler.showFeedback(LanguageService.translate("interestChangeBeforeLoanStart"));
            return;
          }
        }
        const editIndex = changeForm.getAttribute("data-edit-change-index");
        const containerId = (changeType === "interest") ? "interest-changes-list" : "loan-changes-list";
        const listEl = document.getElementById(containerId);
        const isEdit = editIndex !== null && editIndex !== "" && !isNaN(parseInt(editIndex, 10));
        const rowHtml = (itemIdx) => {
          if (changeType === "interest") {
            return `
              <div class="change-item-details">
                <span data-date="${date}">${LanguageService.translate("date")}: ${date}</span>
                <span data-rate="${value}">${LanguageService.translate("rate")}: ${value}%</span>
              </div>
              <div class="change-item-actions">
                <div class="change-item-menu-wrap" data-change-type="interest" data-item-index="${itemIdx}">
                  <button type="button" class="payment-plan-menu-btn change-item-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
                    <span class="material-icons">more_vert</span>
                  </button>
                  <div class="change-item-menu dropdown-menu" role="menu">
                    <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
                    <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
                  </div>
                </div>
              </div>
            `;
          }
          return `
            <div class="change-item-details">
              <span data-date="${date}">${LanguageService.translate("date")}: ${date}</span>
              <span data-amount="${value}">${LanguageService.translate("amount")}: ${value}</span>
            </div>
            <div class="change-item-actions">
              <div class="change-item-menu-wrap" data-change-type="loan" data-item-index="${itemIdx}">
                <button type="button" class="payment-plan-menu-btn change-item-menu-btn" aria-haspopup="true" aria-expanded="false" title="${LanguageService.translate("actions")}">
                  <span class="material-icons">more_vert</span>
                </button>
                <div class="change-item-menu dropdown-menu" role="menu">
                  <button type="button" role="menuitem" data-action="edit">${LanguageService.translate("edit")}</button>
                  <button type="button" role="menuitem" data-action="delete">${LanguageService.translate("delete")}</button>
                </div>
              </div>
            </div>
          `;
        };
        if (isEdit) {
          const row = listEl.children[parseInt(editIndex, 10)];
          if (row) row.innerHTML = rowHtml(parseInt(editIndex, 10));
          changeForm.removeAttribute("data-edit-change-index");
          changeForm.removeAttribute("data-edit-change-type");
        } else {
          const div = document.createElement("div");
          div.className = "change-item";
          div.innerHTML = rowHtml(listEl.children.length);
          listEl.appendChild(div);
        }
        UIHandler.closeModal("add-change-modal");
      });
      this.changeFormBound = true;
    }
  },
  openChangeModal(changeType, editOptions) {
    const changeForm = document.getElementById("change-form");
    changeForm.reset();
    changeForm.removeAttribute("data-edit-change-index");
    changeForm.removeAttribute("data-edit-change-type");
    document.getElementById("changeType").value = changeType;
    const titleEl = document.getElementById("change-modal-title");
    const valueLabel = document.getElementById("changeValueLabel");
    const changeDateInput = document.getElementById("changeDate");
    const changeValueInput = document.getElementById("changeValue");
    if (changeType === "interest") {
      titleEl.textContent = LanguageService.translate("addInterestChange");
      valueLabel.textContent = LanguageService.translate("ratePercentLabel");
      const loanStart = document.getElementById("loanStartDate").value;
      if (loanStart) changeDateInput.setAttribute("min", loanStart);
      else changeDateInput.removeAttribute("min");
      if (editOptions && editOptions.date != null && editOptions.value != null) {
        changeDateInput.value = editOptions.date;
        changeValueInput.value = String(editOptions.value);
        changeForm.setAttribute("data-edit-change-index", String(editOptions.editItemIndex));
        changeForm.setAttribute("data-edit-change-type", "interest");
      } else if (loanStart) {
        const listEmpty = !document.querySelector("#interest-changes-list .change-item");
        if (listEmpty) changeDateInput.value = loanStart;
      }
    } else {
      titleEl.textContent = LanguageService.translate("addLoanChange");
      valueLabel.textContent = LanguageService.translate("amount") + ":";
      changeDateInput.removeAttribute("min");
      if (editOptions && editOptions.date != null && editOptions.value != null) {
        changeDateInput.value = editOptions.date;
        changeValueInput.value = String(editOptions.value);
        changeForm.setAttribute("data-edit-change-index", String(editOptions.editItemIndex));
        changeForm.setAttribute("data-edit-change-type", "loan");
      }
    }
    UIHandler.showModal("add-change-modal");
  },
  async handleLoanFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const isSharedEdit = form.getAttribute("data-shared-edit") === "true";
    const idx = form.getAttribute("data-loan-index");
    const startDate = form.querySelector("#loanStartDate").value;
    let interestChangesCollected = FormHandler.collectInterestChanges();
    if (!interestChangesCollected.length) {
      const initialRateInput = form.querySelector("#loanInitialInterestRate");
      const isNewLoan = idx === null && !isSharedEdit;
      if (isNewLoan && initialRateInput && initialRateInput.offsetParent !== null) {
        const initialRate = Math.max(0, parseFloat(initialRateInput.value) || 0);
        interestChangesCollected = [{ date: startDate, rate: initialRate }];
      } else {
        UIHandler.showFeedback(LanguageService.translate("addAtLeastOneInterest"));
        return;
      }
    }
    const anyBeforeStart = interestChangesCollected.some(ch => ch.date < startDate);
    if (anyBeforeStart) {
      UIHandler.showFeedback(LanguageService.translate("interestChangeBeforeLoanStart"));
      return;
    }
    const sortedByDate = interestChangesCollected.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const firstRate = parseFloat(sortedByDate[0].rate);
    const interestRate = (isNaN(firstRate) ? 0 : Math.max(0, firstRate));
    let loanType = (form.querySelector("#loanType") && form.querySelector("#loanType").value === "lend") ? "lend" : "borrow";
    if (isSharedEdit && UIHandler.currentShare && UIHandler.currentShare.share) {
      const snapshot = UIHandler.currentShare.share.loan_snapshot;
      loanType = snapshot.loanType === "lend" ? "lend" : "borrow";
      const newLoan = {
        id: snapshot.id,
        loanType,
        name: form.querySelector("#loanName").value,
        startDate,
        initialAmount: parseFloat(form.querySelector("#loanInitialAmount").value || 0),
        interestRate,
        currency: form.querySelector("#loanCurrency").value,
        interestChanges: interestChangesCollected,
        loanChanges: FormHandler.collectLoanChanges(),
        payments: snapshot.payments || []
      };
      const result = await ShareService.updateSharedLoan(UIHandler.currentShare.token, newLoan);
      if (result.error) {
        UIHandler.showFeedback(result.error);
        return;
      }
      UIHandler.currentShare.share.loan_snapshot = newLoan;
      UIHandler.closeModal("loan-modal");
      UIHandler.renderDetailContent();
      UIHandler.showFeedback(LanguageService.translate("settingsSaved"));
      return;
    }
    const all = StorageService.load("loanData");
    const newLoan = {
      id: idx ? all[idx].id : Date.now().toString(36) + Math.random().toString(36).substr(2),
      loanType,
      name: form.querySelector("#loanName").value,
      startDate,
      initialAmount: parseFloat(form.querySelector("#loanInitialAmount").value || 0),
      interestRate,
      currency: form.querySelector("#loanCurrency").value,
      interestChanges: interestChangesCollected,
      loanChanges: FormHandler.collectLoanChanges(),
      payments: idx ? all[idx].payments : []
    };
    if (idx !== null) {
      all[idx] = newLoan;
      UIHandler.showFeedback(LanguageService.translate("loanUpdated"));
    } else {
      all.push(newLoan);
      UIHandler.showFeedback(LanguageService.translate("loanSaved"));
    }
    StorageService.save("loanData", all);
    if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
    UIHandler.closeModal("loan-modal");
    UIHandler.renderLoans();
    if (idx === null) setTimeout(() => UIHandler.maybeShowSecurityPrompt(), 600);
  },
  collectInterestChanges() {
    const arr = [];
    document.querySelectorAll("#interest-changes-list .change-item").forEach(div => {
      const d = div.querySelector("[data-date]").getAttribute("data-date");
      const r = parseFloat(div.querySelector("[data-rate]").getAttribute("data-rate"));
      arr.push({ date: d, rate: r });
    });
    return arr.sort((a, b) => new Date(a.date) - new Date(b.date));
  },
  collectLoanChanges() {
    const arr = [];
    document.querySelectorAll("#loan-changes-list .change-item").forEach(div => {
      const d = div.querySelector("[data-date]").getAttribute("data-date");
      const amt = parseFloat(div.querySelector("[data-amount]").getAttribute("data-amount"));
      arr.push({ date: d, amount: amt });
    });
    return arr;
  },
  openAmortizationForm(loanIndex, paymentIndex = null, prefilled = null) {
    const modal = document.getElementById("amortization-modal");
    const form = document.getElementById("amortization-form-modal");
    const removeBtn = document.getElementById("remove-amortization-btn");
    const freqSelect = document.getElementById("amortizationFrequency");
    const unitSelect = document.getElementById("amortizationFrequencyUnit");
    const whenMonth = document.getElementById("schedule-when-month");
    const whenWeek = document.getElementById("schedule-when-week");

    function setIntervalOptionsForUnit(unit) {
      const isWeek = unit === "week";
      freqSelect.innerHTML = "";
      const max = isWeek ? 4 : 12;
      for (let i = 1; i <= max; i++) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = String(i);
        freqSelect.appendChild(opt);
      }
      const current = parseInt(freqSelect.value || "1", 10);
      freqSelect.value = String(Math.min(Math.max(1, current), max));
    }

    function updateScheduleSummary() {
      const startStr = document.getElementById("amortizationStartDate").value;
      const unit = unitSelect.value;
      const freq = parseInt(freqSelect.value || "1", 10);
      const endStr = document.getElementById("amortizationEndDate").value;
      const lastWeekday = document.getElementById("lastDayBeforeWeekend").checked;
      const summaryEl = document.getElementById("occurrenceSummary");
      const endSummaryEl = document.getElementById("endDateSummary");

      if (!startStr) {
        summaryEl.textContent = "";
        endSummaryEl.textContent = "";
        return;
      }
      const date = new Date(startStr + "T12:00:00");
      const day = date.getDate();
      const weekdayNames = LanguageService.currentLanguage === "sv"
        ? ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"]
        : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const weekday = weekdayNames[date.getDay()];

      if (unit === "week") {
        document.getElementById("selectedWeekday").textContent = weekday;
        if (freq === 1) {
          summaryEl.textContent = `${LanguageService.translate("occursEveryWeekday")} ${weekday}.`;
        } else {
          summaryEl.textContent = `${LanguageService.translate("occursEveryWeekday")} ${freq} ${LanguageService.translate("everyWeeks").toLowerCase()} (${weekday}).`;
        }
      } else {
        document.getElementById("selectedDay").textContent = day;
        if (lastWeekday) {
          summaryEl.textContent = `${LanguageService.translate("lastDayBeforeWeekend")}.`;
        } else {
          summaryEl.textContent = `${LanguageService.translate("occursDayOfMonth")} ${day} ${LanguageService.translate("ofMonth")}.`;
        }
      }
      if (endStr) {
        const endDate = new Date(endStr + "T12:00:00");
        endSummaryEl.textContent = " — " + endDate.toLocaleDateString(LanguageService.currentLanguage === "sv" ? "sv-SE" : "en-US");
      } else {
        endSummaryEl.textContent = "";
      }
    }

    form.reset();
    form.removeAttribute("data-payment-index");
    form.removeAttribute("data-edit-mode");
    document.getElementById("amortizationLoanId").value = loanIndex;

    if (paymentIndex !== null) {
      const ld = StorageService.load("loanData");
      const p = ld[loanIndex].payments[paymentIndex];
      form.setAttribute("data-payment-index", paymentIndex);
      form.setAttribute("data-edit-mode", "true");
      document.getElementById("amortizationAmount").value = p.amount;
      document.getElementById("amortizationStartDate").value = p.startDate;
      document.getElementById("amortizationType").value = p.type;
      unitSelect.value = p.frequencyUnit || "month";
      setIntervalOptionsForUnit(unitSelect.value);
      document.getElementById("amortizationFrequency").value = String(Math.min(12, Math.max(1, parseInt(p.frequency || "1", 10))));
      if (unitSelect.value === "week") {
        document.getElementById("amortizationFrequency").value = String(Math.min(4, Math.max(1, parseInt(p.frequency || "1", 10))));
      }
      document.getElementById("amortizationEndDate").value = p.endDate || "";
      document.getElementById("dayOfMonth").checked = !p.lastWeekdayOfMonth;
      document.getElementById("lastDayBeforeWeekend").checked = !!p.lastWeekdayOfMonth;
      whenMonth.style.display = unitSelect.value === "month" ? "" : "none";
      whenWeek.style.display = unitSelect.value === "week" ? "" : "none";
      updateScheduleSummary();
      removeBtn.style.display = "block";
      removeBtn.setAttribute("data-loan-index", loanIndex);
      removeBtn.setAttribute("data-payment-index", paymentIndex);
      removeBtn.onclick = () => { ConfirmHandler.confirmDelete('amortization', loanIndex, paymentIndex); };
      UIHandler.setLockState(modal, ["amortizationAmount", "amortizationStartDate"], true);
    } else {
      removeBtn.style.display = "none";
      removeBtn.removeAttribute("data-loan-index");
      removeBtn.removeAttribute("data-payment-index");
      UIHandler.setLockState(modal, ["amortizationAmount", "amortizationStartDate"], false);
      unitSelect.value = "month";
      setIntervalOptionsForUnit("month");
      if (prefilled && prefilled.amount != null && prefilled.startDate) {
        document.getElementById("amortizationAmount").value = prefilled.amount;
        document.getElementById("amortizationStartDate").value = prefilled.startDate;
        document.getElementById("amortizationEndDate").value = prefilled.endDate != null ? prefilled.endDate : "";
        document.getElementById("amortizationType").value = prefilled.type || "scheduled";
        if (prefilled.frequencyUnit === "week") {
          unitSelect.value = "week";
          setIntervalOptionsForUnit("week");
          document.getElementById("amortizationFrequency").value = String(Math.min(4, Math.max(1, parseInt(prefilled.frequency || "1", 10))));
        } else {
          document.getElementById("amortizationFrequency").value = prefilled.frequency || "1";
        }
        document.getElementById("dayOfMonth").checked = !prefilled.lastWeekdayOfMonth;
        document.getElementById("lastDayBeforeWeekend").checked = !!prefilled.lastWeekdayOfMonth;
        whenMonth.style.display = unitSelect.value === "month" ? "" : "none";
        whenWeek.style.display = unitSelect.value === "week" ? "" : "none";
        updateScheduleSummary();
      } else {
        const ld = StorageService.load("loanData");
        const loan = ld[loanIndex];
        const defaultDate = (loan && loan.startDate) ? loan.startDate : new Date().toISOString().split("T")[0];
        document.getElementById("amortizationStartDate").value = defaultDate;
        updateScheduleSummary();
      }
      whenMonth.style.display = "block";
      whenWeek.style.display = "none";
    }

    unitSelect.onchange = () => {
      setIntervalOptionsForUnit(unitSelect.value);
      whenMonth.style.display = unitSelect.value === "month" ? "" : "none";
      whenWeek.style.display = unitSelect.value === "week" ? "" : "none";
      updateScheduleSummary();
    };
    freqSelect.onchange = updateScheduleSummary;
    document.getElementById("amortizationStartDate").onchange = () => updateScheduleSummary();
    document.getElementById("amortizationEndDate").onchange = () => updateScheduleSummary();
    document.getElementById("dayOfMonth").onchange = updateScheduleSummary;
    document.getElementById("lastDayBeforeWeekend").onchange = updateScheduleSummary;

    UIHandler.showModal("amortization-modal");
  },
  async handleAmortizationFormSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const loanIndex = parseInt(document.getElementById("amortizationLoanId").value);
    const paymentIndex = form.getAttribute("data-payment-index");
    const ld = StorageService.load("loanData");
    const loan = ld[loanIndex];
    const startDateStr = document.getElementById("amortizationStartDate").value;
    const isScheduled = document.getElementById("amortizationType").value === "scheduled";
    const frequencyUnit = document.getElementById("amortizationFrequencyUnit").value;
    const p = {
      amount: parseFloat(document.getElementById("amortizationAmount").value || 0),
      startDate: startDateStr,
      type: document.getElementById("amortizationType").value,
      frequency: isScheduled ? document.getElementById("amortizationFrequency").value : null,
      frequencyUnit: isScheduled ? frequencyUnit : null,
      endDate: document.getElementById("amortizationEndDate").value || null,
      status: "active",
      dayOfMonth: new Date(startDateStr + "T12:00:00").getDate().toString(),
      lastWeekdayOfMonth: !!document.getElementById("lastDayBeforeWeekend").checked
    };
    // Validate scheduled payment for overlapping dates (exclude current payment when editing).
    if (p.type === "scheduled") {
      const editIndex = paymentIndex !== null && paymentIndex !== "" ? parseInt(paymentIndex, 10) : null;
      const validation = validateNewPayment(loan, p, editIndex);
      if (!validation.valid) {
        UIHandler.showFeedback(validation.warning);
        return;
      }
    }
    if (!loan.payments) loan.payments = [];
    if (paymentIndex !== null) {
      loan.payments[paymentIndex] = p;
      UIHandler.showFeedback(LanguageService.translate("amortizationSaved"));
    } else {
      loan.payments.push(p);
      UIHandler.showFeedback(LanguageService.translate("amortizationSaved"));
    }
    StorageService.save("loanData", ld);
    if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
    UIHandler.closeModal("amortization-modal");
    UIHandler.renderLoans();
  }
};

/********************************************************
 * 6. CHART HANDLER
 ********************************************************/
const ChartHandler = {
  buildChart(timeline, chartContainer, currency, loanOptional) {
    if (window.amortizationChart) { window.amortizationChart.dispose(); window.amortizationChart = null; }
    if (typeof echarts === 'undefined') return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const currentMonthIndex = timeline.findIndex(row => {
      const d = new Date(row.date);
      return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
    });
    let totalInterest = 0, totalAmort = 0;
    const chartData = timeline.reduce((acc, row) => {
      acc.labels.push(UIHandler.formatDate(row.paymentDate));
      acc.debt.push(row.endingDebt);
      totalInterest += row.interest;
      acc.interest.push(totalInterest);
      totalAmort += row.amortization;
      acc.amort.push(totalAmort);
      return acc;
    }, { labels: [], debt: [], interest: [], amort: [] });
    const timelineData = timeline;
    const debtLabel = (loanOptional && loanOptional.loanType === "lend") ? LanguageService.translate("owedToYou") : LanguageService.translate("remainingDebt");
    const tickColor = getComputedStyle(document.documentElement).getPropertyValue('--text-color').trim() || 'rgba(255,255,255,0.9)';
    const todayLabel = chartData.labels[currentMonthIndex];
    const todayMarkLine = (currentMonthIndex >= 0 && todayLabel)
      ? {
          markLine: {
            symbol: ['none', 'none'],
            lineStyle: { color: 'rgba(255, 165, 0, 0.95)', type: 'dashed', width: 2 },
            label: { formatter: LanguageService.translate('today'), color: '#fff', backgroundColor: 'rgba(0,0,0,0.7)', padding: [4, 8] },
            data: [[{ xAxis: todayLabel, yAxis: 0 }, { xAxis: todayLabel, yAxis: 'max' }]]
          }
        }
      : {};
    const option = {
      grid: { left: 60, right: 40, top: 50, bottom: 50 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(0,0,0,0.9)',
        borderWidth: 0,
        textStyle: { color: '#eee', fontSize: 13 },
        formatter: function(params) {
          if (!params || !params.length || params[0].dataIndex == null) return '';
          const idx = params[0].dataIndex;
          const point = timelineData[idx];
          if (!point) return '';
          const dateStr = UIHandler.formatDate(point.paymentDate);
          const periodLines = [
            debtLabel + ': ' + UIHandler.formatCurrency(point.endingDebt, currency),
            LanguageService.translate('interestCost') + ': ' + UIHandler.formatCurrency(point.interest, currency),
            LanguageService.translate('amortization') + ': ' + UIHandler.formatCurrency(point.amortization, currency),
            LanguageService.translate('paymentLabel') + ': ' + UIHandler.formatCurrency(point.payment, currency)
          ];
          const accumInterest = chartData.interest[idx];
          const accumAmort = chartData.amort[idx];
          const accumLines = [
            LanguageService.translate('accumulatedInterest') + ': ' + UIHandler.formatCurrency(accumInterest, currency),
            LanguageService.translate('accumulatedAmortization') + ': ' + UIHandler.formatCurrency(accumAmort, currency)
          ];
          return '<div class="chart-tooltip-date">' + dateStr + '</div>' +
            periodLines.join('<br/>') +
            '<br/><div class="chart-tooltip-accumulated">' + accumLines.join('<br/>') + '</div>';
        }
      },
      xAxis: {
        type: 'category',
        data: chartData.labels,
        axisLabel: { color: tickColor, fontSize: 12, maxInterval: 0 },
        axisLine: { lineStyle: { color: tickColor } },
        axisTick: { lineStyle: { color: tickColor } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: { color: tickColor, fontSize: 12, formatter: value => UIHandler.formatCurrency(value, currency) },
        axisLine: { show: false },
        axisTick: { lineStyle: { color: tickColor } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
      },
      legend: {
        top: 0,
        textStyle: { color: tickColor, fontSize: 13 },
        itemGap: 20
      },
      series: [
        { name: debtLabel, type: 'line', data: chartData.debt, symbol: 'none', lineStyle: { width: 2, color: 'rgb(75, 192, 192)' }, itemStyle: { color: 'rgb(75, 192, 192)' }, ...todayMarkLine },
        { name: LanguageService.translate('interestCost'), type: 'line', data: chartData.interest, symbol: 'none', lineStyle: { width: 1, color: 'rgb(255, 99, 132)' }, itemStyle: { color: 'rgb(255, 99, 132)' } },
        { name: LanguageService.translate('amortization'), type: 'line', data: chartData.amort, symbol: 'none', lineStyle: { width: 1, color: 'rgb(54, 162, 235)' }, itemStyle: { color: 'rgb(54, 162, 235)' } }
      ]
    };
    window.amortizationChart = echarts.init(chartContainer);
    window.amortizationChart.setOption(option);
  },
  buildChartInDetailView() {
    const loan = UIHandler.getCurrentLoan();
    if (!loan) return;
    const container = document.getElementById("loan-detail-chart-container");
    if (!container) return;
    const fullTimeline = CalculationService.buildTimeline(loan);
    ChartHandler.buildChart(fullTimeline, container, loan.currency, loan);
    setTimeout(() => {
      if (window.amortizationChart) window.amortizationChart.resize();
    }, 50);
  }
};

/********************************************************
 * 7. CONFIRM HANDLER
 ********************************************************/
const ConfirmHandler = {
  pending: null,
  confirmDelete(type, loanIndex, paymentIndex, element) {
    this.pending = { type, loanIndex, paymentIndex, element };
    document.body.style.overflow = "hidden";
    document.getElementById("delete-confirmation-modal").style.display = "flex";
  },
  async executeDelete() {
    if (!this.pending) return;
    const { type, loanIndex, paymentIndex } = this.pending;
    const all = StorageService.load("loanData");
    if (type === "loan") {
      all.splice(loanIndex, 1);
      StorageService.save("loanData", all);
      if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
      if (UIHandler.currentDetailLoanIndex !== null && loanIndex === UIHandler.currentDetailLoanIndex) {
        UIHandler.showLoanList();
      } else {
        UIHandler.renderLoans();
      }
      UIHandler.showFeedback(LanguageService.translate("loanRemoved"));
      UIHandler.closeModal("loan-modal");
    } else if (type === "amortization") {
      all[loanIndex].payments.splice(paymentIndex, 1);
      StorageService.save("loanData", all);
      if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
      UIHandler.renderLoans();
      UIHandler.showFeedback(LanguageService.translate("amortizationRemoved"));
      UIHandler.closeModal("amortization-modal");
    } else if (type === "interestChange" || type === "loanChange") {
      const row = this.pending.element.closest(".change-item");
      if (row) row.remove();
    }
    this.pending = null;
    document.getElementById("delete-confirmation-modal").style.display = "none";
    UIHandler.restoreBodyScroll();
  },
  cancelDelete() {
    this.pending = null;
    document.getElementById("delete-confirmation-modal").style.display = "none";
    UIHandler.restoreBodyScroll();
  }
};

/********************************************************
 * 8. DOCUMENT READY & LOGIN/SYNC SETUP
 ********************************************************/
document.addEventListener("DOMContentLoaded", async () => {
  LanguageService.init();
  (function setupVersionCheck() {
    const meta = document.querySelector('meta[name="app-version"]');
    const current = meta ? (meta.getAttribute("content") || "").trim() : "";
    if (!current) return;
    const url = window.location.origin + window.location.pathname;
    let updateModalShown = false;
    function checkNewVersion() {
      if (localStorage.getItem("offlineMode") || updateModalShown) return;
      fetch(url + "?_v=" + Date.now(), { cache: "no-store" })
        .then((r) => r.text())
        .then((html) => {
          const m = html.match(/<meta\s+name="app-version"\s+content="([^"]*)"/);
          const serverVer = m ? (m[1] || "").trim() : "";
          if (serverVer && serverVer !== current) {
            updateModalShown = true;
            UIHandler.showModal("update-available-modal");
          }
        })
        .catch(() => {});
    }
    setInterval(checkNewVersion, 60000);
    setTimeout(checkNewVersion, 15000);
  })();
  document.getElementById("update-available-refresh-btn")?.addEventListener("click", () => location.reload());
  const searchParams = new URLSearchParams(window.location.search);
  const shareFromUrl = searchParams.get("share") || null;
  window._pendingShareToken = shareFromUrl;
  if (shareFromUrl) sessionStorage.setItem("lendpile_pendingShareToken", shareFromUrl);
  else window._pendingShareToken = sessionStorage.getItem("lendpile_pendingShareToken");
  const hash = window.location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (accessToken && supabaseClient) {
      try {
        await supabaseClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken || "" });
        window._emailJustVerified = true;
      } catch (e) {
        console.error("Session recovery from URL failed:", e);
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } else {
      const error = params.get("error");
      const errorCode = params.get("error_code");
      const errorDesc = params.get("error_description");
      if (error || errorCode || errorDesc) {
        const feedback = document.getElementById("login-feedback");
        feedback.textContent = LanguageService.translate("linkExpiredOrInvalid");
        feedback.className = "";
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
  }
  const loginModal = document.getElementById("login-modal");
  const loginCloseBtn = loginModal.querySelector(".btn-close");
  loginCloseBtn.addEventListener("click", () => {
    localStorage.setItem("offlineMode", "true");
    loginModal.style.display = "none";
    UIHandler.restoreBodyScroll();
    UIHandler.sharesReceived = [];
    UIHandler.init();
    showLoginPane();
  });
  let needMfaChallenge = false;
  if (!localStorage.getItem("offlineMode")) {
    const user = await AuthService.getUser();
    if (!user) {
      const shareLanding = document.getElementById("login-share-landing");
      const previewText = document.getElementById("login-share-preview-text");
      const invalidText = document.getElementById("login-share-invalid-text");
      if (window._pendingShareToken && shareLanding && previewText && invalidText) {
        shareLanding.classList.remove("hidden");
        previewText.classList.add("hidden");
        invalidText.classList.add("hidden");
        try {
          // Link stays valid until someone signs in and accepts (redeem), or until expires_at. Preview does not consume the link.
          const { data: preview, error } = await supabaseClient.rpc("get_share_preview", { share_token: window._pendingShareToken });
          if (error || !preview) {
            previewText.classList.add("hidden");
            invalidText.classList.remove("hidden");
            invalidText.textContent = LanguageService.translate("sharedLinkExpired");
          } else {
            const owner = preview.owner_display_name || LanguageService.translate("someone");
            const loanName = preview.loan_name || LanguageService.translate("loan");
            const intro = LanguageService.translate("sharedLoanPreviewIntro");
            const titleLabel = LanguageService.translate("sharedLoanPreviewTitleLabel");
            const signIn = LanguageService.translate("signInToViewShare");
            previewText.textContent = `${owner} ${intro}\n${titleLabel} ${loanName}\n\n${signIn}`;
            previewText.classList.remove("hidden");
            invalidText.classList.add("hidden");
          }
        } catch (e) {
          previewText.classList.add("hidden");
          invalidText.classList.remove("hidden");
          invalidText.textContent = LanguageService.translate("sharedLinkExpired");
        }
        if (window._pendingShareToken) updateLoginPaneShareContext();
      } else if (shareLanding) {
        shareLanding.classList.add("hidden");
      }
      document.body.style.overflow = "hidden";
      loginModal.style.display = "flex";
      showLoginPane();
    } else {
    const aal = await AuthService.getAuthenticatorAssuranceLevel();
    if (aal.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
      needMfaChallenge = true;
      document.getElementById("mfa-challenge-code").value = "";
      document.getElementById("mfa-challenge-feedback").textContent = "";
      document.getElementById("mfa-challenge-feedback").className = "";
      UIHandler.showModal("mfa-challenge-modal");
      window._mfaChallengeResolve = async () => {
        const syncedData = await SyncService.loadData();
        StorageService.save("loanData", syncedData ?? []);
        const { shares: sharesReceived } = await ShareService.listSharesReceived();
        UIHandler.sharesReceived = sharesReceived || [];
        UIHandler.init();
        await updateUserHeader();
        await tryRedeemPendingShare();
        if (window._emailJustVerified) {
          window._emailJustVerified = false;
          UIHandler.showFeedback(LanguageService.translate("emailVerifiedWelcome"));
        }
        setTimeout(() => UIHandler.maybeShowSecurityPrompt(), 1200);
      };
    } else {
      const syncedData = await SyncService.loadData();
      StorageService.save("loanData", syncedData ?? []);
    }
    }
  }
  if (!needMfaChallenge) {
    const user = await AuthService.getUser();
    if (user) {
      const syncedData = await SyncService.loadData();
      StorageService.save("loanData", syncedData ?? []);
      const { shares: sharesReceived } = await ShareService.listSharesReceived();
      UIHandler.sharesReceived = sharesReceived || [];
    } else {
      UIHandler.sharesReceived = [];
    }
    UIHandler.init();
    await updateUserHeader();
    await updateOfflineBanner();
    if (user) await tryRedeemPendingShare();
    if (window._emailJustVerified) {
      window._emailJustVerified = false;
      UIHandler.showFeedback(LanguageService.translate("emailVerifiedWelcome"));
    }
    setTimeout(() => UIHandler.maybeShowSecurityPrompt(), 1200);
  }
  const profileIconBtn = document.getElementById("profile-icon-btn");
  const profileDropdown = document.getElementById("profile-dropdown");
  if (profileIconBtn && profileDropdown) {
    profileIconBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      profileDropdown.classList.toggle("open");
      profileIconBtn.setAttribute("aria-expanded", profileDropdown.classList.contains("open"));
    });
    document.addEventListener("click", () => {
      profileDropdown.classList.remove("open");
      profileIconBtn.setAttribute("aria-expanded", "false");
    });
  }
  document.getElementById("profile-logout").addEventListener("click", async () => {
    profileDropdown.classList.remove("open");
    await AuthService.signOut();
    localStorage.removeItem("offlineMode");
    StorageService.save("loanData", []);
    location.reload();
  });
  document.getElementById("change-password-cancel").addEventListener("click", () => {
    UIHandler.closeModal("change-password-modal");
  });
  document.getElementById("change-password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const feedback = document.getElementById("change-password-feedback");
    const currentPass = document.getElementById("current-password").value;
    const newPass = document.getElementById("new-password").value;
    const confirmPass = document.getElementById("confirm-password").value;
    feedback.textContent = "";
    feedback.className = "";
    if (newPass !== confirmPass) {
      feedback.textContent = LanguageService.translate("passwordsDoNotMatch");
      feedback.className = "error";
      return;
    }
    if (!isStrongPassword(newPass)) {
      feedback.textContent = LanguageService.translate("invalidPasswordStrength");
      feedback.className = "error";
      return;
    }
    if (!supabaseClient) {
      feedback.textContent = "Supabase not configured.";
      feedback.className = "error";
      return;
    }
    const user = await AuthService.getUser();
    if (!user?.email) {
      feedback.textContent = LanguageService.translate("currentPasswordIncorrect");
      feedback.className = "error";
      return;
    }
    const signInResult = await AuthService.signIn(user.email, currentPass);
    if (!signInResult.success) {
      feedback.textContent = LanguageService.translate("currentPasswordIncorrect");
      feedback.className = "error";
      return;
    }
    const { error } = await supabaseClient.auth.updateUser({ password: newPass });
    if (error) {
      feedback.textContent = error.message;
      feedback.className = "error";
      return;
    }
    feedback.textContent = LanguageService.translate("passwordUpdated");
    feedback.className = "success";
    document.getElementById("change-password-form").reset();
    setTimeout(() => UIHandler.closeModal("change-password-modal"), 1500);
  });

  /* Account: email list – menu toggle and actions (delegation) */
  document.getElementById("account-email-list")?.addEventListener("click", (e) => {
    const menuBtn = e.target.closest(".account-email-menu-btn");
    const menuItem = e.target.closest(".account-email-menu [data-action]");
    if (menuBtn) {
      e.stopPropagation();
      document.querySelectorAll(".account-email-menu.open").forEach(m => m.classList.remove("open"));
      const menu = menuBtn.nextElementSibling;
      if (menu) menu.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", menu && menu.classList.contains("open"));
      return;
    }
    if (menuItem) {
      const wrap = menuItem.closest(".account-email-item-wrap");
      const email = wrap?.getAttribute("data-email");
      const isDefault = wrap?.getAttribute("data-is-default") === "true";
      const action = menuItem.getAttribute("data-action");
      document.querySelectorAll(".account-email-menu.open").forEach(m => m.classList.remove("open"));
      if (action === "change") {
        window._accountChangeEmailFor = email;
        window._accountChangeEmailIsPrimary = isDefault;
        document.getElementById("account-change-email-inline").style.display = "block";
        document.getElementById("account-new-email").value = email;
        document.getElementById("account-email-change-feedback").style.display = "none";
      } else if (action === "setDefault" && !isDefault) {
        (async () => {
          const feedback = document.getElementById("account-email-change-feedback");
          feedback.style.display = "block";
          feedback.className = "";
          const result = await AuthService.updateUser({ email: email, data: { recovery_email: null } });
          if (result.success) {
            feedback.textContent = LanguageService.translate("emailChangeSent");
            feedback.className = "success";
            const u = await AuthService.getUser();
            if (u) renderAccountEmailList(u);
            await populateAccountSettings();
          } else {
            feedback.textContent = result.error || "Error";
            feedback.className = "error";
          }
        })();
      } else if (action === "delete" && !isDefault) {
        (async () => {
          const result = await AuthService.updateUser({ data: { recovery_email: null } });
          if (result.success) {
            const u = await AuthService.getUser();
            if (u) renderAccountEmailList(u);
            await populateAccountSettings();
            document.getElementById("account-email-change-feedback").style.display = "none";
          }
        })();
      }
    }
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".account-email-menu.open").forEach(m => m.classList.remove("open"));
  });
  /* Account: change email inline – send verification */
  document.querySelector(".account-cancel-email-change")?.addEventListener("click", () => {
    document.getElementById("account-change-email-inline").style.display = "none";
    window._accountChangeEmailFor = null;
    window._accountChangeEmailIsPrimary = null;
    document.getElementById("account-email-change-feedback").style.display = "none";
  });
  document.querySelector(".account-send-email-change")?.addEventListener("click", async () => {
    const newEmail = document.getElementById("account-new-email")?.value.trim();
    const feedback = document.getElementById("account-email-change-feedback");
    if (!newEmail) return;
    feedback.style.display = "block";
    feedback.className = "";
    const isPrimary = window._accountChangeEmailIsPrimary;
    const result = isPrimary
      ? await AuthService.updateUser({ email: newEmail })
      : await AuthService.updateUser({ data: { recovery_email: newEmail } });
    if (result.success) {
      feedback.textContent = isPrimary ? LanguageService.translate("emailChangeSent") : LanguageService.translate("settingsSaved");
      feedback.className = "success";
      document.getElementById("account-change-email-inline").style.display = "none";
      window._accountChangeEmailFor = null;
      window._accountChangeEmailIsPrimary = null;
      const u = await AuthService.getUser();
      if (u) renderAccountEmailList(u);
      await populateAccountSettings();
    } else {
      feedback.textContent = result.error || "Error";
      feedback.className = "error";
    }
  });
  /* Account: add another email (secondary) */
  document.getElementById("account-add-email-link")?.addEventListener("click", () => {
    document.getElementById("account-email-add-wrap").style.display = "block";
    document.getElementById("account-add-email-link").style.display = "none";
    document.getElementById("account-new-secondary-email").value = "";
  });
  document.querySelector(".account-cancel-add-email")?.addEventListener("click", async () => {
    document.getElementById("account-email-add-wrap").style.display = "none";
    const user = await AuthService.getUser();
    const recovery = (user?.user_metadata && user.user_metadata.recovery_email) ? String(user.user_metadata.recovery_email).trim() : "";
    document.getElementById("account-add-email-link").style.display = recovery ? "none" : "";
  });
  document.querySelector(".account-add-email-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("account-new-secondary-email");
    const value = input?.value.trim();
    if (!value) return;
    const result = await AuthService.updateUser({ data: { recovery_email: value } });
    if (result.success) {
      document.getElementById("account-email-add-wrap").style.display = "none";
      document.getElementById("account-add-email-link").style.display = "none";
      const u = await AuthService.getUser();
      if (u) renderAccountEmailList(u);
      await populateAccountSettings();
    }
  });
  /* Account: change password button (opens modal) */
  document.getElementById("account-change-password-btn")?.addEventListener("click", () => {
    document.getElementById("change-password-form").reset();
    document.getElementById("change-password-feedback").textContent = "";
    document.getElementById("change-password-feedback").className = "";
    UIHandler.closeModal("account-modal");
    UIHandler.showModal("change-password-modal");
  });
  /* Account: export all data */
  document.getElementById("account-export-data-btn")?.addEventListener("click", async () => {
    const loans = StorageService.load("loanData") || [];
    const user = await AuthService.getUser();
    const payload = {
      exportedAt: new Date().toISOString(),
      loans,
      account: user ? { email: user.email, displayName: (user.user_metadata && user.user_metadata.display_name) || null } : null
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lendpile-data-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    UIHandler.showFeedback(LanguageService.translate("dataExported"));
  });
  /* Account: delete account – open confirmation modal */
  document.getElementById("account-delete-account-btn")?.addEventListener("click", () => {
    document.getElementById("delete-account-form").reset();
    document.getElementById("delete-account-feedback").textContent = "";
    document.getElementById("delete-account-feedback").className = "";
    UIHandler.closeModal("account-modal");
    UIHandler.showModal("delete-account-modal");
  });
  document.getElementById("delete-account-cancel")?.addEventListener("click", () => UIHandler.closeModal("delete-account-modal"));
  /* Security prompt (2FA / recovery email) */
  document.getElementById("security-prompt-close")?.addEventListener("click", () => UIHandler.closeModal("security-prompt-modal"));
  document.getElementById("security-prompt-setup")?.addEventListener("click", async () => {
    UIHandler.closeModal("security-prompt-modal");
    UIHandler.showModal("account-modal");
    await populateAccountSettings();
  });
  document.getElementById("security-prompt-later")?.addEventListener("click", () => {
    const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem("lendpile_securityPrompt", "later");
    localStorage.setItem("lendpile_securityPromptLaterAt", in7Days);
    UIHandler.closeModal("security-prompt-modal");
  });
  document.getElementById("security-prompt-dismiss")?.addEventListener("click", () => {
    localStorage.setItem("lendpile_securityPrompt", "dismissed");
    UIHandler.closeModal("security-prompt-modal");
  });
  /* Share loan modal */
  document.getElementById("share-modal-close")?.addEventListener("click", () => UIHandler.closeModal("share-loan-modal"));
  async function executeCreateShareLink(loan, permission, recipientView, expiresInDays) {
    const result = await ShareService.createShare(loan, { permission, recipientView, expiresInDays });
    const feedbackEl = document.getElementById("share-link-feedback");
    const resultEl = document.getElementById("share-link-result");
    if (result.error) {
      feedbackEl.textContent = result.error;
      feedbackEl.className = "error";
      feedbackEl.style.display = "block";
      resultEl.style.display = "none";
      return;
    }
    document.getElementById("share-link-url").value = result.shareUrl;
    feedbackEl.style.display = "none";
    feedbackEl.className = "";
    resultEl.style.display = "block";
    UIHandler.populateShareActiveList();
  }
  document.getElementById("share-create-link-btn")?.addEventListener("click", async () => {
    const loanIndex = UIHandler.shareLoanIndex;
    if (loanIndex == null) return;
    const loans = StorageService.load("loanData") || [];
    let loan = loans[loanIndex];
    if (!loan) return;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!loan.id || !uuidRe.test(String(loan.id))) {
      loan = { ...loan, id: crypto.randomUUID() };
      loans[loanIndex] = loan;
      StorageService.save("loanData", loans);
      if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
    }
    const permission = document.querySelector("#share-loan-modal input[name=share-permission]:checked")?.value || "view";
    const recipientView = document.querySelector("#share-loan-modal input[name=share-recipient-view]:checked")?.value || "borrowing";
    const expiresInDays = parseInt(document.getElementById("share-expires-days")?.value, 10) || 7;
    const user = await AuthService.getUser();
    const hasDisplayName = user && (user.user_metadata && user.user_metadata.display_name && String(user.user_metadata.display_name).trim());
    if (!hasDisplayName && user) {
      UIHandler.showConfirmModal({
        title: LanguageService.translate("shareEmailShownTitle"),
        message: LanguageService.translate("shareEmailShownMessage"),
        confirmLabel: LanguageService.translate("shareAddDisplayName"),
        cancelLabel: LanguageService.translate("shareCreateLinkAnyway"),
        onConfirm: () => {
          UIHandler.cancelGenericConfirm();
          UIHandler.closeModal("share-loan-modal");
          UIHandler.showModal("account-modal");
        },
        onCancel: () => {
          UIHandler.cancelGenericConfirm();
          executeCreateShareLink(loan, permission, recipientView, expiresInDays);
        }
      });
      return;
    }
    await executeCreateShareLink(loan, permission, recipientView, expiresInDays);
  });
  document.getElementById("share-copy-link-btn")?.addEventListener("click", () => {
    const input = document.getElementById("share-link-url");
    if (!input?.value) return;
    input.select();
    input.setSelectionRange(0, 99999);
    try {
      navigator.clipboard.writeText(input.value);
      const fb = document.getElementById("share-link-feedback");
      fb.textContent = LanguageService.translate("copied");
      fb.className = "";
      fb.style.display = "block";
    } catch (_) {}
  });
  document.getElementById("delete-account-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const feedback = document.getElementById("delete-account-feedback");
    const password = document.getElementById("delete-account-password")?.value;
    const typeDelete = document.getElementById("delete-account-type-delete")?.value?.trim() || "";
    feedback.textContent = "";
    feedback.className = "";
    if (typeDelete !== "DELETE") {
      feedback.textContent = LanguageService.translate("deleteAccountTypeDelete");
      feedback.className = "error";
      return;
    }
    const user = await AuthService.getUser();
    if (!user?.email) {
      feedback.textContent = LanguageService.translate("currentPasswordIncorrect");
      feedback.className = "error";
      return;
    }
    const signInResult = await AuthService.signIn(user.email, password);
    if (!signInResult.success) {
      feedback.textContent = LanguageService.translate("currentPasswordIncorrect");
      feedback.className = "error";
      return;
    }
    if (!supabaseClient) {
      feedback.textContent = "Supabase not configured.";
      feedback.className = "error";
      return;
    }
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) {
      feedback.textContent = LanguageService.translate("deleteAccountUnavailable");
      feedback.className = "error";
      return;
    }
    const deleteAccountUrl = window.DELETE_ACCOUNT_URL || (SUPABASE_URL && `${SUPABASE_URL}/functions/v1/delete-my-account`);
    if (!deleteAccountUrl) {
      feedback.textContent = LanguageService.translate("deleteAccountUnavailable");
      feedback.className = "error";
      return;
    }
    let deleteError = null;
    try {
      const res = await fetch(deleteAccountUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        deleteError = { message: (body && body.error) || body || LanguageService.translate("deleteAccountUnavailable") };
      }
    } catch (err) {
      deleteError = { message: err.message || LanguageService.translate("deleteAccountUnavailable") };
    }
    if (deleteError) {
      feedback.textContent = typeof deleteError.message === "string" ? deleteError.message : LanguageService.translate("deleteAccountUnavailable");
      feedback.className = "error";
      return;
    }
    await AuthService.signOut();
    localStorage.removeItem("offlineMode");
    UIHandler.closeModal("delete-account-modal");
    location.reload();
  });
  /* Account section: display name */
  document.querySelector(".account-save-display-name")?.addEventListener("click", async () => {
    const input = document.getElementById("account-display-name");
    if (!input) return;
    const value = input.value.trim();
    const result = await AuthService.updateUser({ data: { display_name: value || null } });
    if (result.success) {
      await updateUserHeader();
      UIHandler.showFeedback(LanguageService.translate("settingsSaved"));
    } else {
      UIHandler.showFeedback(result.error || "Error");
    }
  });
  /* Account section: enable 2FA – open enroll modal */
  document.getElementById("account-mfa-enable")?.addEventListener("click", async () => {
    const feedback = document.getElementById("mfa-enroll-feedback");
    const qrEl = document.getElementById("mfa-enroll-qr");
    const secretWrap = document.getElementById("mfa-secret-wrap");
    const secretEl = document.getElementById("mfa-enroll-secret");
    const codeEl = document.getElementById("mfa-enroll-code");
    if (!qrEl || !codeEl || !feedback) return;
    qrEl.innerHTML = "";
    codeEl.value = "";
    feedback.textContent = "";
    feedback.className = "";
    if (secretWrap) secretWrap.style.display = "none";
    if (secretEl) secretEl.textContent = "";
    const { data, error } = await AuthService.mfaEnroll();
    if (error) {
      let msg = error.message || "Failed to start 2FA setup.";
      if (error.status === 422 || msg.toLowerCase().includes("422") || msg.toLowerCase().includes("unprocessable")) {
        msg += " Enable MFA in Supabase Dashboard: Authentication → Multi-Factor (MFA).";
      }
      feedback.textContent = msg;
      feedback.className = "error";
      UIHandler.showModal("mfa-enroll-modal");
      return;
    }
    const totp = data && data.totp;
    const svg = totp && totp.qr_code;
    if (svg && typeof svg === "string") {
      if (svg.trim().toLowerCase().startsWith("<svg")) {
        try {
          qrEl.innerHTML = svg;
          const firstSvg = qrEl.querySelector("svg");
          if (firstSvg) {
            firstSvg.setAttribute("width", "180");
            firstSvg.setAttribute("height", "180");
          }
        } catch (_) {
          const img = document.createElement("img");
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
          img.alt = "QR code";
          qrEl.appendChild(img);
        }
      } else {
        const img = document.createElement("img");
        img.src = svg.indexOf("data:") === 0 ? svg : "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        img.alt = "QR code";
        qrEl.appendChild(img);
      }
    }
    const secret = totp && totp.secret;
    if (secretWrap && secretEl && secret) {
      secretEl.textContent = secret;
      secretWrap.style.display = "block";
    }
    window._mfaEnrollFactorId = data ? data.id : null;
    UIHandler.showModal("mfa-enroll-modal");
  });
  document.getElementById("mfa-copy-secret")?.addEventListener("click", () => {
    const secretEl = document.getElementById("mfa-enroll-secret");
    if (!secretEl || !secretEl.textContent) return;
    navigator.clipboard.writeText(secretEl.textContent).then(() => {
      const btn = document.getElementById("mfa-copy-secret");
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = LanguageService.translate("copied");
        setTimeout(() => { btn.textContent = orig; }, 2000);
      }
    });
  });
  /* MFA enroll: verify button */
  document.getElementById("mfa-enroll-verify")?.addEventListener("click", async () => {
    const factorId = window._mfaEnrollFactorId;
    const codeEl = document.getElementById("mfa-enroll-code");
    const feedback = document.getElementById("mfa-enroll-feedback");
    if (!factorId || !codeEl || !feedback) return;
    const code = codeEl.value.trim().replace(/\s/g, "");
    if (code.length !== 6) {
      feedback.textContent = LanguageService.translate("verificationCode") + " (6 digits)";
      feedback.className = "error";
      return;
    }
    feedback.textContent = "";
    feedback.className = "";
    const challengeRes = await AuthService.mfaChallenge(factorId);
    if (challengeRes.error) {
      feedback.textContent = challengeRes.error.message || "Challenge failed.";
      feedback.className = "error";
      return;
    }
    const verifyRes = await AuthService.mfaVerify({
      factorId,
      challengeId: challengeRes.data.id,
      code
    });
    if (verifyRes.error) {
      feedback.textContent = verifyRes.error.message || "Verification failed.";
      feedback.className = "error";
      return;
    }
    feedback.textContent = LanguageService.translate("settingsSaved");
    feedback.className = "success";
    window._mfaEnrollFactorId = null;
    setTimeout(async () => {
      UIHandler.closeModal("mfa-enroll-modal");
      await populateAccountSettings();
    }, 1200);
  });
  document.getElementById("mfa-enroll-cancel")?.addEventListener("click", () => {
    window._mfaEnrollFactorId = null;
    UIHandler.closeModal("mfa-enroll-modal");
  });
  document.querySelector("#mfa-enroll-modal .btn-close")?.addEventListener("click", () => {
    window._mfaEnrollFactorId = null;
    UIHandler.closeModal("mfa-enroll-modal");
  });
  /* Account section: disable 2FA */
  document.getElementById("account-mfa-disable")?.addEventListener("click", () => {
    UIHandler.showConfirmModal({
      title: LanguageService.translate("disable2FA") + "?",
      confirmLabel: LanguageService.translate("disable2FA"),
      confirmClass: "btn-delete",
      onConfirm: async () => {
        const factors = await AuthService.mfaListFactors();
        const totp = factors.data && factors.data.totp && factors.data.totp[0];
        if (!totp) return;
        const { error } = await AuthService.mfaUnenroll(totp.id);
        if (error) {
          UIHandler.showFeedback(error.message || "Failed to disable 2FA.");
          return;
        }
        await populateAccountSettings();
        UIHandler.showFeedback(LanguageService.translate("settingsSaved"));
      }
    });
  });

  document.getElementById("loan-form-modal").addEventListener("submit", async e => {
    await FormHandler.handleLoanFormSubmit(e);
  });
  document.getElementById("amortization-form-modal").addEventListener("submit", async e => {
    await FormHandler.handleAmortizationFormSubmit(e);
  });

  document.querySelector(".container").addEventListener("click", (e) => {
    const calcBtn = e.target.closest(".btn-calculate-target");
    if (calcBtn) {
      const index = parseInt(calcBtn.getAttribute("data-loan-index"), 10);
      const input = document.getElementById("target-date-input-" + index);
      const dateStr = input && input.value;
      if (!dateStr) return;
      const loans = StorageService.load("loanData");
      const loan = loans[index];
      const amount = CalculationService.calculatePaymentForTargetDate(loan, dateStr);
      const resultDiv = document.getElementById("target-date-result-" + index);
      const msgEl = resultDiv && resultDiv.querySelector(".target-date-required-msg");
      if (!resultDiv || !msgEl) return;
      if (amount == null) {
        msgEl.textContent = LanguageService.translate("targetDateInvalid");
      } else {
        msgEl.textContent = LanguageService.translate("requiredMonthlyPayment") + ": " + UIHandler.formatCurrency(amount, loan.currency);
        resultDiv.dataset.targetAmount = amount;
        resultDiv.dataset.targetEndDate = dateStr;
      }
      resultDiv.style.display = "block";
      return;
    }
    const applyBtn = e.target.closest(".btn-apply-target-payment");
    if (applyBtn) {
      const index = parseInt(applyBtn.getAttribute("data-loan-index"), 10);
      const resultDiv = document.getElementById("target-date-result-" + index);
      if (!resultDiv || resultDiv.dataset.targetAmount == null) return;
      const amount = parseFloat(resultDiv.dataset.targetAmount);
      const endDate = resultDiv.dataset.targetEndDate;
      const loans = StorageService.load("loanData");
      const loan = loans[index];
      FormHandler.openAmortizationForm(index, null, { amount, startDate: loan.startDate, endDate, type: "scheduled" });
    }
  });

  document.getElementById("back-to-loans").addEventListener("click", (e) => {
    e.preventDefault();
    UIHandler.showLoanList();
  });
  document.getElementById("view-detail").addEventListener("click", (e) => {
    const tab = e.target.closest(".loan-detail-tab");
    if (!tab) return;
    const tabName = tab.getAttribute("data-tab");
    document.querySelectorAll(".loan-detail-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll("#loan-detail-content .tab-pane").forEach(p => p.classList.remove("active"));
    const pane = document.querySelector(`#loan-detail-content .tab-pane[data-pane="${tabName}"]`);
    if (pane) pane.classList.add("active");
    if (tabName === "chart") {
      setTimeout(() => ChartHandler.buildChartInDetailView(), 50);
    } else if (tabName === "amortizations") {
      setTimeout(() => {
        const scrollWrap = document.querySelector("#loan-detail-content .tab-pane[data-pane=amortizations] .table-body-scroll");
        const currentRow = scrollWrap ? scrollWrap.querySelector("tr.current-month") : null;
        if (scrollWrap && currentRow) currentRow.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 100);
    }
  });

  /* Interest/loan change item menus live inside #loan-modal (sibling of .container), so delegate on document. */
  document.addEventListener("click", (e) => {
    const changeItemMenuBtn = e.target.closest(".change-item-menu-btn");
    if (changeItemMenuBtn) {
      e.stopPropagation();
      const wrap = changeItemMenuBtn.closest(".change-item-menu-wrap");
      const menu = wrap && wrap.querySelector(".change-item-menu");
      document.querySelectorAll(".change-item-menu.dropdown-menu").forEach(m => m.classList.remove("open"));
      if (menu) menu.classList.toggle("open");
      changeItemMenuBtn.setAttribute("aria-expanded", menu && menu.classList.contains("open"));
      return;
    }
    const changeItemMenuItem = e.target.closest(".change-item-menu-wrap button[data-action]");
    if (changeItemMenuItem) {
      e.stopPropagation();
      const wrap = changeItemMenuItem.closest(".change-item-menu-wrap");
      const menu = wrap && wrap.querySelector(".change-item-menu");
      if (menu) menu.classList.remove("open");
      const changeType = wrap ? wrap.getAttribute("data-change-type") : null;
      const itemIndex = wrap ? parseInt(wrap.getAttribute("data-item-index"), 10) : -1;
      const action = changeItemMenuItem.getAttribute("data-action");
      const row = wrap ? wrap.closest(".change-item") : null;
      if (action === "edit" && row && changeType && !isNaN(itemIndex)) {
        const dateEl = row.querySelector("[data-date]");
        const valueEl = row.querySelector("[data-rate], [data-amount]");
        const date = dateEl ? dateEl.getAttribute("data-date") : "";
        const value = valueEl ? parseFloat(valueEl.getAttribute("data-rate") || valueEl.getAttribute("data-amount") || "0") : 0;
        FormHandler.openChangeModal(changeType, { editItemIndex: itemIndex, date, value });
      } else if (action === "delete" && changeType) {
        ConfirmHandler.confirmDelete(changeType === "interest" ? "interestChange" : "loanChange", null, null, changeItemMenuItem);
      }
      return;
    }
  });

  document.querySelector(".container").addEventListener("click", (e) => {
    const overviewBtn = e.target.closest(".overview-detail-menu-btn");
    if (overviewBtn) {
      e.stopPropagation();
      const wrap = overviewBtn.closest(".overview-detail-menu-wrap");
      const menu = wrap && wrap.querySelector(".overview-detail-menu");
      document.querySelectorAll(".overview-detail-menu.dropdown-menu").forEach(m => m.classList.remove("open"));
      if (menu) menu.classList.toggle("open");
      overviewBtn.setAttribute("aria-expanded", menu && menu.classList.contains("open"));
      return;
    }
    const overviewItem = e.target.closest(".overview-detail-menu button[data-action]");
    if (overviewItem) {
      e.stopPropagation();
      const wrap = overviewItem.closest(".overview-detail-menu-wrap");
      const menu = wrap && wrap.querySelector(".overview-detail-menu");
      if (menu) menu.classList.remove("open");
      const index = wrap ? parseInt(wrap.getAttribute("data-loan-index"), 10) : null;
      const action = overviewItem.getAttribute("data-action");
      const isShared = wrap && wrap.getAttribute("data-shared") === "true";
      if (isShared) {
        if (action === "edit") {
          if (UIHandler.currentShare && UIHandler.currentShare.share && UIHandler.currentShare.share.permission === "view") {
            FormHandler.openLoanModalForSharedViewOnly();
          } else {
            FormHandler.openLoanModalForSharedLoan();
          }
        } else if (action === "duplicate") UIHandler.duplicateSharedLoanToMyList();
        else if (action === "remove-shared") UIHandler.showRemoveSharedLoanModal(UIHandler.currentShare);
      } else if (index != null && action === "edit") FormHandler.openLoanModal(index);
      else if (index != null && action === "share") UIHandler.openShareModal(index);
      else if (index != null && action === "duplicate") FormHandler.duplicateLoan(index).then(() => UIHandler.showLoanList());
      else if (index != null && action === "delete") ConfirmHandler.confirmDelete("loan", index);
      return;
    }
    const loanCardMenuBtn = e.target.closest(".loan-detail-menu-btn");
    if (loanCardMenuBtn) {
      e.stopPropagation();
      const wrap = loanCardMenuBtn.closest(".loan-detail-menu-wrap");
      const menu = wrap && wrap.querySelector(".loan-detail-menu");
      document.querySelectorAll(".loan-detail-menu.open").forEach(m => m.classList.remove("open"));
      if (menu) menu.classList.toggle("open");
      loanCardMenuBtn.setAttribute("aria-expanded", menu && menu.classList.contains("open"));
      return;
    }
    const loanCardMenuItem = e.target.closest(".loan-detail-menu [data-action]");
    if (loanCardMenuItem) {
      e.stopPropagation();
      const menu = loanCardMenuItem.closest(".loan-detail-menu");
      if (menu) menu.classList.remove("open");
      const cardIndex = parseInt(loanCardMenuItem.getAttribute("data-loan-index"), 10);
      const merged = UIHandler._mergedLoansList || [];
      const item = merged[cardIndex];
      const action = loanCardMenuItem.getAttribute("data-action");
      if (item && item._shared) {
        if (action === "edit") {
          UIHandler.currentShare = item._shared;
          if (item._shared.share?.permission === "view") FormHandler.openLoanModalForSharedViewOnly();
          else FormHandler.openLoanModalForSharedLoan();
        } else if (action === "duplicate") {
          UIHandler.currentShare = item._shared;
          UIHandler.duplicateSharedLoanToMyList();
        } else if (action === "remove-shared") {
          UIHandler.showRemoveSharedLoanModal(item._shared);
        }
      } else {
        const myIndex = item && item._myIndex !== undefined ? item._myIndex : cardIndex;
        if (action === "edit") FormHandler.openLoanModal(myIndex);
        else if (action === "duplicate") FormHandler.duplicateLoan(myIndex).then(() => { UIHandler.showLoanList(); });
        else if (action === "delete") ConfirmHandler.confirmDelete("loan", myIndex);
      }
      return;
    }
    const paymentPlanBtn = e.target.closest(".payment-plan-menu-btn");
    if (paymentPlanBtn) {
      e.stopPropagation();
      const wrap = paymentPlanBtn.closest(".payment-plan-menu-wrap");
      const menu = wrap && wrap.querySelector(".payment-plan-menu");
      document.querySelectorAll(".payment-plan-menu.dropdown-menu").forEach(m => m.classList.remove("open"));
      if (menu) menu.classList.toggle("open");
      paymentPlanBtn.setAttribute("aria-expanded", menu && menu.classList.contains("open"));
      return;
    }
    const paymentPlanItem = e.target.closest(".payment-plan-menu button[data-action]");
    if (paymentPlanItem) {
      e.stopPropagation();
      if (UIHandler.currentShare && UIHandler.currentShare.share?.permission === "view") return;
      const wrap = paymentPlanItem.closest(".payment-plan-menu-wrap");
      const menu = wrap && wrap.querySelector(".payment-plan-menu");
      if (menu) menu.classList.remove("open");
      const loanIndex = wrap ? parseInt(wrap.getAttribute("data-loan-index"), 10) : null;
      const paymentIndex = wrap ? parseInt(wrap.getAttribute("data-payment-index"), 10) : null;
      const action = paymentPlanItem.getAttribute("data-action");
      if (loanIndex == null) return;
      if (action === "edit") FormHandler.openAmortizationForm(loanIndex, paymentIndex);
      else if (action === "delete") ConfirmHandler.confirmDelete("amortization", loanIndex, paymentIndex);
      else if (action === "duplicate") {
        const loans = StorageService.load("loanData");
        const loan = loans[loanIndex];
        const payment = loan && loan.payments && loan.payments[paymentIndex];
        if (payment) {
          FormHandler.openAmortizationForm(loanIndex, null, {
            amount: payment.amount,
            startDate: payment.startDate,
            endDate: payment.endDate || "",
            type: payment.type || "scheduled",
            frequency: payment.frequency || "1",
            frequencyUnit: payment.frequencyUnit || "month",
            lastWeekdayOfMonth: !!payment.lastWeekdayOfMonth
          });
        }
      }
      return;
    }
    const addAmortBtn = e.target.closest(".btn-add-amortization");
    if (addAmortBtn) {
      e.stopPropagation();
      if (UIHandler.currentShare && UIHandler.currentShare.share?.permission === "view") return;
      const loanIndex = parseInt(addAmortBtn.getAttribute("data-loan-index"), 10);
      if (!isNaN(loanIndex)) FormHandler.openAmortizationForm(loanIndex);
      return;
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".overview-detail-menu-wrap, .payment-plan-menu-wrap, .change-item-menu-wrap, .loan-detail-menu-wrap")) return;
    document.querySelectorAll(".overview-detail-menu.dropdown-menu.open, .payment-plan-menu.dropdown-menu.open, .change-item-menu.dropdown-menu.open, .loan-detail-menu.open").forEach(m => m.classList.remove("open"));
    document.querySelectorAll(".overview-detail-menu-btn[aria-expanded=true], .payment-plan-menu-btn[aria-expanded=true], .change-item-menu-btn[aria-expanded=true], .loan-detail-menu-btn[aria-expanded=true]").forEach(b => b.setAttribute("aria-expanded", "false"));
  });

  document.getElementById("confirm-delete-btn").addEventListener("click", async () => {
    await ConfirmHandler.executeDelete();
  });
  document.getElementById("cancel-delete-btn").addEventListener("click", () => {
    ConfirmHandler.cancelDelete();
  });
  document.getElementById("confirm-remove-shared-btn").addEventListener("click", () => {
    UIHandler.confirmRemoveSharedLoan();
  });
  document.getElementById("cancel-remove-shared-btn").addEventListener("click", () => {
    UIHandler.cancelRemoveSharedLoan();
  });

  document.getElementById("generic-confirm-btn").addEventListener("click", async () => {
    const fn = window._genericConfirmOnConfirm;
    if (typeof fn === "function") {
      window._genericConfirmOnConfirm = null;
      UIHandler.closeModal("generic-confirm-modal");
      await fn();
    }
  });
  document.getElementById("generic-confirm-cancel-btn").addEventListener("click", () => {
    const onCancel = window._genericConfirmOnCancel;
    if (typeof onCancel === "function") onCancel();
    UIHandler.cancelGenericConfirm();
  });

  document.getElementById("confirm-unlock-btn").addEventListener("click", () => {
    UIHandler.confirmUnlock();
  });
  
  document.getElementById("export-select-all").addEventListener("change", function() {
    document.querySelectorAll(".loan-export-checkbox").forEach(cb => { cb.checked = this.checked; });
  });
  document.getElementById("btn-export").addEventListener("click", () => {
    const loanData = StorageService.load("loanData") || [];
    const checked = document.querySelectorAll(".loan-export-checkbox:checked");
    const indices = Array.from(checked).map(cb => parseInt(cb.getAttribute("data-loan-index"), 10)).filter(i => !isNaN(i));
    const feedbackEl = document.getElementById("export-loans-feedback");
    if (indices.length === 0) {
      if (feedbackEl) {
        feedbackEl.textContent = LanguageService.translate("selectAtLeastOneLoan");
        feedbackEl.className = "error";
        feedbackEl.style.display = "block";
      }
      return;
    }
    const toExport = indices.map(i => loanData[i]).filter(Boolean);
    const str = JSON.stringify(toExport, null, 2);
    const blob = new Blob([str], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lendpile_loans_${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    if (feedbackEl) feedbackEl.style.display = "none";
    UIHandler.showFeedback(LanguageService.translate("loansExported"));
  });
  
  document.getElementById("btn-import-data").addEventListener("click", () => {
    document.getElementById("btn-import-file").click();
  });
  document.getElementById("btn-import-file").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target.result);
        let imported = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.loans) ? parsed.loans : null);
        if (!imported || !imported.length) throw new Error("Invalid format");
        imported = imported.map(loan => ({
          ...loan,
          id: loan.id || crypto.randomUUID()
        }));
        let current = StorageService.load("loanData") || [];
        const overlapping = imported.filter(importedLoan => {
          return current.find(c => c.id === importedLoan.id) !== undefined;
        });
        if (overlapping.length > 0) {
          let modal = document.getElementById("import-confirmation-modal");
          if (!modal) {
            modal = document.createElement("div");
            modal.id = "import-confirmation-modal";
            modal.className = "modal";
            document.body.appendChild(modal);
          }
          modal.innerHTML = `
            <div class="modal-content">
              <span class="btn-close">&times;</span>
              <h2>${LanguageService.translate("importWarning")}</h2>
              <p>${LanguageService.translate("importWarningMessage")}</p>
              <ul id="conflicting-loans-list"></ul>
              <p>${LanguageService.translate("importChoice")}</p>
              <div class="modal-actions">
                <button id="overwrite-loans-btn" class="btn-delete">${LanguageService.translate("overwriteLoans")}</button>
                <button id="import-as-new-btn" class="btn-primary">${LanguageService.translate("importAsNew")}</button>
                <button id="cancel-import-btn" class="btn-primary">${LanguageService.translate("cancel")}</button>
              </div>
            </div>
          `;
          const list = document.getElementById("conflicting-loans-list");
          list.innerHTML = overlapping.map(loan => {
            const existing = current.find(c => c.id === loan.id);
            return `<li>"${escapeHtml(existing ? existing.name : '')}" ${LanguageService.translate('willBeOverwritten')} "${escapeHtml(loan.name)}"</li>`;
          }).join("");
          modal.style.display = "flex";
          const handleImport = async (asNew) => {
              if (asNew) {
                  imported.forEach(l => {
                      let newLoan = { ...l, id: crypto.randomUUID() };
                      let baseName = newLoan.name;
                      let counter = 1;
                      while (current.some(existingLoan => existingLoan.name === newLoan.name)) {
                          newLoan.name = `${baseName} (${counter})`;
                          counter++;
                      }
                      current.push(newLoan);
                  });
              } else {
                  imported.forEach(l => {
                      const existingIdx = current.findIndex(c => c.id === l.id);
                      if (existingIdx >= 0) current[existingIdx] = l;
                      else current.push(l);
                  });
              }
              StorageService.save("loanData", current);
              if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
              UIHandler.renderLoans();
              UIHandler.showFeedback(LanguageService.translate("dataImported"));
              UIHandler.closeModal("settings-modal");
              modal.style.display = "none";
              e.target.value = "";
          };
          modal.querySelector(".btn-close").onclick = () => {
            modal.style.display = "none";
            e.target.value = "";
          };
          document.getElementById("overwrite-loans-btn").onclick = async () => { await handleImport(false); };
          document.getElementById("import-as-new-btn").onclick = async () => { await handleImport(true); };
          document.getElementById("cancel-import-btn").onclick = () => {
            modal.style.display = "none";
            e.target.value = "";
          };
          modal.addEventListener("click", ev => {
            if (ev.target === modal) {
              modal.style.display = "none";
              e.target.value = "";
            }
          });
        } else {
          imported.forEach(l => {
            const existingIdx = current.findIndex(c => c.id === l.id);
            if (existingIdx >= 0) current[existingIdx] = l;
            else current.push(l);
          });
          StorageService.save("loanData", current);
          if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
          UIHandler.renderLoans();
          UIHandler.showFeedback(LanguageService.translate("dataImported"));
          UIHandler.closeModal("settings-modal");
          e.target.value = "";
        }
      } catch (err) {
        console.error(err);
        UIHandler.showFeedback(LanguageService.translate("importError"));
      }
    };
    reader.readAsText(file);
  });
  
  document.getElementById("language-select").addEventListener("change", e => {
    const val = e.target.value;
    LanguageService.setLanguage(val);
    UIHandler.showFeedback(LanguageService.translate("settingsSaved"));
    setTimeout(() => location.reload(), 1500);
  });
  const storedLang = localStorage.getItem("preferredLanguage") || "sv";
  document.getElementById("language-select").value = storedLang;
  
  // Listen for coming online to trigger a sync
  window.addEventListener("online", async () => {
    if (!localStorage.getItem("offlineMode")) await SyncService.syncData();
  });
});

/********************************************************
 * LOGIN / SIGNUP EVENT HANDLERS
 ********************************************************/
async function tryRedeemPendingShare() {
  if (!window._pendingShareToken) return;
  const result = await ShareService.redeemShare(window._pendingShareToken);
  const token = window._pendingShareToken;
  window._pendingShareToken = null;
  sessionStorage.removeItem("lendpile_pendingShareToken");
  window.history.replaceState(null, "", window.location.pathname + (window.location.hash || ""));
  if (result.error) UIHandler.showFeedback(result.error);
  else if (result.share) {
    UIHandler.sharesReceived = [{ ...result.share, token }, ...(UIHandler.sharesReceived || [])];
    UIHandler.currentShare = { token, share: result.share };
    UIHandler.showSharedLoan();
  }
}
async function onLoginSuccess() {
  document.getElementById("login-modal").style.display = "none";
  UIHandler.restoreBodyScroll();
  localStorage.removeItem("offlineMode");
  const syncedData = await SyncService.loadData();
  StorageService.save("loanData", syncedData ?? []);
  const { shares: sharesReceived } = await ShareService.listSharesReceived();
  UIHandler.sharesReceived = sharesReceived || [];
  UIHandler.init();
  await updateUserHeader();
  await updateOfflineBanner();
  await tryRedeemPendingShare();
  UIHandler.checkTransferOffers();
  UIHandler.checkEditRequests();
  UIHandler.checkEditResolutionBanner();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("login-feedback");
  feedback.textContent = "";
  feedback.className = "";
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  if (!email || !password) {
    feedback.textContent = LanguageService.translate("enterEmailAndPassword");
    return;
  }
  const result = await AuthService.signIn(email, password);
  if (!result.success) {
    feedback.textContent = result.error;
    return;
  }
  const aal = await AuthService.getAuthenticatorAssuranceLevel();
  if (aal.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
    document.getElementById("login-modal").style.display = "none";
    UIHandler.restoreBodyScroll();
    document.getElementById("mfa-challenge-code").value = "";
    document.getElementById("mfa-challenge-feedback").textContent = "";
    document.getElementById("mfa-challenge-feedback").className = "";
    UIHandler.showModal("mfa-challenge-modal");
    window._mfaChallengeResolve = onLoginSuccess;
    return;
  }
  await onLoginSuccess();
});

document.getElementById("mfa-challenge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const codeEl = document.getElementById("mfa-challenge-code");
  const feedback = document.getElementById("mfa-challenge-feedback");
  const code = codeEl && codeEl.value.trim().replace(/\s/g, "");
  if (!code || code.length !== 6) {
    if (feedback) { feedback.textContent = LanguageService.translate("verificationCode") + " (6 digits)"; feedback.className = "error"; }
    return;
  }
  if (feedback) { feedback.textContent = ""; feedback.className = ""; }
  const factors = await AuthService.mfaListFactors();
  const totp = factors.data && factors.data.totp && factors.data.totp[0];
  if (!totp) {
    if (feedback) { feedback.textContent = "No 2FA factor found."; feedback.className = "error"; }
    return;
  }
  const challengeRes = await AuthService.mfaChallenge(totp.id);
  if (challengeRes.error) {
    if (feedback) { feedback.textContent = challengeRes.error.message; feedback.className = "error"; }
    return;
  }
  const verifyRes = await AuthService.mfaVerify({
    factorId: totp.id,
    challengeId: challengeRes.data.id,
    code
  });
  if (verifyRes.error) {
    if (feedback) { feedback.textContent = verifyRes.error.message; feedback.className = "error"; }
    return;
  }
  UIHandler.closeModal("mfa-challenge-modal");
  const resolve = window._mfaChallengeResolve;
  window._mfaChallengeResolve = null;
  if (typeof resolve === "function") resolve();
});
document.getElementById("mfa-challenge-close")?.addEventListener("click", async () => {
  UIHandler.closeModal("mfa-challenge-modal");
  window._mfaChallengeResolve = null;
  await AuthService.signOut();
  document.getElementById("login-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
});

document.getElementById("work-offline-btn").addEventListener("click", () => {
  localStorage.setItem("offlineMode", "true");
  document.getElementById("login-modal").style.display = "none";
  UIHandler.restoreBodyScroll();
  LanguageService.init();
  UIHandler.sharesReceived = [];
  UIHandler.init();
  updateOfflineBanner();
});

document.getElementById("offline-banner-signin-btn").addEventListener("click", () => {
  showLoginPane();
  document.getElementById("login-modal").style.display = "flex";
  document.body.style.overflow = "hidden";
});

document.getElementById("login-to-signup-link").addEventListener("click", () => { showSignupPane(); });
document.getElementById("signup-to-login-link").addEventListener("click", () => { showLoginPane(); });

document.getElementById("login-modal-close").addEventListener("click", () => {
  document.getElementById("login-modal").style.display = "none";
  UIHandler.restoreBodyScroll();
  showLoginPane();
});

document.getElementById("signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const feedback = document.getElementById("login-feedback");
  feedback.textContent = "";
  feedback.className = "";
  const email = document.getElementById("signup-email").value.trim();
  const displayName = document.getElementById("signup-display-name") && document.getElementById("signup-display-name").value.trim();
  const password = document.getElementById("signup-password").value;
  const confirm = document.getElementById("signup-password-confirm").value;
  if (!email || !password) {
    feedback.textContent = LanguageService.translate("enterEmailAndPassword");
    return;
  }
  if (password !== confirm) {
    feedback.textContent = LanguageService.translate("passwordsDoNotMatch");
    feedback.className = "error";
    return;
  }
  if (!isStrongPassword(password)) {
    feedback.textContent = LanguageService.translate("invalidPasswordStrength");
    feedback.className = "error";
    return;
  }
  const shareToken = window._pendingShareToken;
  const emailRedirectTo = shareToken
    ? (window.location.origin + window.location.pathname + "?share=" + encodeURIComponent(shareToken))
    : undefined;
  const result = await AuthService.signUp(email, password, displayName, emailRedirectTo);
  if (result.success) {
    feedback.textContent = LanguageService.translate("signUpSuccess");
    feedback.className = "success";
    document.getElementById("signup-form").reset();
  } else {
    feedback.textContent = result.error;
    feedback.className = "error";
  }
});
