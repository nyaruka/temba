from temba.channels.views import AuthenticatedExternalCallbackClaimView


class ClaimView(AuthenticatedExternalCallbackClaimView):
    class Form(AuthenticatedExternalCallbackClaimView.Form):
        # numbers are always in Somalia
        country = None

    form_class = Form

    def get_submitted_country(self, data):
        return "SO"
