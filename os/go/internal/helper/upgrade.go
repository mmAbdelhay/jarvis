package helper

import (
	"context"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// upgradeTimeout bounds one AptUpgrade/FlatpakUpdate run. It equals
// installTimeout so the client's PackageCallTimeout still covers
// update (5 min) + query (1 min) + this.
const upgradeTimeout = installTimeout

// AptUpgrade upgrades installed Debian packages (M2 contracts §2). Names
// that are not installed are dropped, never installed: `--only-upgrade`
// would skip them anyway, and dropping them first also stops apt from
// reading a non-exact name as a regex that matches other packages. dpkg
// keeps the existing version of a changed config file (--force-confold) so
// an upgrade can never stop at a conffile prompt with no terminal.
func (s *Service) AptUpgrade(ctx context.Context, sender string, names []string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.AptUpgradeNames(names); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionPackages); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshAptLists(ctx)
	args := append([]string{"-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--"}, names...)
	res, _ := s.Run.Run(ctx, execx.Cmd{Name: "dpkg-query", Args: args, Timeout: queryTimeout})
	installed := map[string]bool{}
	for _, st := range parse.DpkgQuery(string(res.Stdout)) {
		installed[st.Name] = st.Installed
	}
	var keep []string
	for _, n := range names {
		if installed[n] {
			keep = append(keep, n)
		}
	}
	if len(keep) == 0 {
		return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "none of these packages is installed")
	}
	cmd := append([]string{"install", "--only-upgrade", "-y", "--no-install-recommends", "--no-remove",
		"-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "--"}, keep...)
	return s.run(ctx, upgradeTimeout, "apt-get", cmd...), nil
}

// FlatpakUpdate updates system-wide apps that came from Flathub (M2
// contracts §2). Every ref must be an installed app whose origin is
// flathub; one that is not refuses the whole call, as FlatpakRemove does.
func (s *Service) FlatpakUpdate(ctx context.Context, sender string, refs []string) (helperapi.Outcome, error) {
	defer s.begin()()
	if err := validate.FlatpakUpdateRefs(refs); err != nil {
		return helperapi.Outcome{}, invalidErr(err)
	}
	if err := s.authorize(ctx, sender, helperapi.ActionPackages); err != nil {
		return helperapi.Outcome{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, r := range refs {
		res, err := s.Run.Run(ctx, execx.Cmd{Name: "flatpak", Args: []string{"info", "--system", r}, Timeout: queryTimeout})
		if err != nil || res.ExitCode != 0 {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotFound, "%s is not installed system-wide", r)
		}
		info, perr := parse.FlatpakDetails(string(res.Stdout))
		if perr != nil || !isAppRef(info.Ref, r) {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%s is not an installed app", r)
		}
		if info.Origin != flathubRemote {
			return helperapi.Outcome{}, refuse(helperapi.ErrNotAllowed, "%s was not installed from Flathub", r)
		}
	}
	args := append([]string{"update", "--system", "-y", "--app"}, refs...)
	return s.run(ctx, upgradeTimeout, "flatpak", args...), nil
}
