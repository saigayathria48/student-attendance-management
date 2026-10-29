import hudson.model.User
import hudson.security.FullControlOnceLoggedInAuthorizationStrategy
import hudson.security.HudsonPrivateSecurityRealm
import jenkins.model.Jenkins

def instance = Jenkins.get()
def password = System.getenv('JENKINS_ADMIN_PASSWORD')
if (!password) {
  println 'JENKINS_ADMIN_PASSWORD is not set; no admin account was created.'
  return
}
instance.setSecurityRealm(new HudsonPrivateSecurityRealm(false))
if (User.getById('admin', false) == null) {
  instance.getSecurityRealm().createAccount('admin', password)
  println 'Created the local admin account.'
}
def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
instance.setAuthorizationStrategy(strategy)
instance.setLabelString('linux')
instance.save()
println 'Security realm, authorization, and linux node label configured.'
