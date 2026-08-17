export class CredentialAdapter {
  constructor(providerId) {
    if (!providerId) throw new Error("A credential adapter requires a provider id.");
    this.providerId = providerId;
  }

  account() { throw new Error("CredentialAdapter.account() must be implemented."); }
  login() { throw new Error("CredentialAdapter.login() must be implemented."); }
  logout() { throw new Error("CredentialAdapter.logout() must be implemented."); }
  close() { return Promise.resolve(); }
}
