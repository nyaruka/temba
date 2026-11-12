from temba.channels.views import AuthenticatedExternalClaimView


class ClaimView(AuthenticatedExternalClaimView):
    class Form(AuthenticatedExternalClaimView.Form):
        # numbers are always in Pakistan
        country = None

    form_class = Form

    def get_submitted_country(self, data):
        return "PK"
